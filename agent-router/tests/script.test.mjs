import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { modelOptions } from './fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridge = join(root, 'scripts', 'bridge.mjs');
const status = join(root, 'scripts', 'status.mjs');
const sessionId = 'script-session';
const bootstrap = JSON.stringify({ action: 'bootstrap', session_id: sessionId, options: modelOptions });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-router-script-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'config');
  mkdirSync(join(config, 'plugins'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: config };
  return {
    directory,
    config,
    env,
    registry(plugins) {
      writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
    },
    run(extraEnv = {}, input = bootstrap, args = []) {
      return spawnSync(process.execPath, [bridge, ...args], {
        env: { ...env, ...extraEnv }, input, encoding: 'utf8', timeout: 10_000,
      });
    },
    sessions(data) {
      const result = spawnSync(process.execPath, [status, '--data', data, '--json'], {
        env, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).sessions.map(session => session.sessionId);
    },
  };
}

function assertBootstrap(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).active, false);
}

test('explicit CLAUDE_PLUGIN_DATA works without an installation registry', t => {
  const f = fixture(t);
  const data = join(f.directory, 'explicit-data');
  assertBootstrap(f.run({ CLAUDE_PLUGIN_DATA: data }));
  assert.deepEqual(f.sessions(data), [sessionId]);
  assert.equal(existsSync(join(f.config, 'plugins', 'data')), false);
});

test('exact installed root selects its identity despite another marketplace with the same name', t => {
  const f = fixture(t);
  f.registry({
    'agent-router@agent-router-tools': [{ installPath: root }],
    'agent-router@other': [{ installPath: join(f.directory, 'other-version') }],
  });
  assertBootstrap(f.run());
  assert.deepEqual(f.sessions(join(f.config, 'plugins', 'data', 'agent-router-agent-router-tools')), [sessionId]);
  assert.equal(existsSync(join(f.config, 'plugins', 'data', 'agent-router-other')), false);
});

test('retained or source root resolves a unique identity after the cached version changes', t => {
  const f = fixture(t);
  const newer = join(f.directory, 'cache', 'agent-router-tools', 'agent-router', '0.5.0');
  mkdirSync(newer, { recursive: true });
  f.registry({ 'agent-router@agent-router-tools': [{ installPath: newer }] });
  assertBootstrap(f.run());
  assert.deepEqual(f.sessions(join(f.config, 'plugins', 'data', 'agent-router-agent-router-tools')), [sessionId]);
});

test('ambiguous manifest identity refuses to choose a shared data directory', t => {
  const f = fixture(t);
  f.registry({
    'agent-router@agent-router-tools': [{ installPath: join(f.directory, 'first') }],
    'agent-router@other': [{ installPath: join(f.directory, 'second') }],
  });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(join(f.config, 'plugins', 'data')), false);
});

test('stderr errors redact both supported credentials without producing hook output', t => {
  const f = fixture(t);
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    const secret = 'secret-token';
    const result = f.run({ [key]: secret }, `${secret}!`);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(secret), false);
    assert.match(result.stderr, /\[redacted\]/);
  }
});

test('bridge rejects CLI data overrides and oversized multibyte stdin', t => {
  const f = fixture(t);
  const data = join(f.directory, 'rejected');
  const argsResult = f.run({}, bootstrap, ['--data', data]);
  assert.equal(argsResult.status, 1);
  assert.equal(argsResult.stdout, '');
  const inputResult = f.run({ CLAUDE_PLUGIN_DATA: data }, JSON.stringify({ value: 'é'.repeat(4 * 1024 * 1024) }));
  assert.equal(inputResult.status, 1);
  assert.equal(inputResult.stdout, '');
  assert.equal(existsSync(data), false);
});
