import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { transformAsync } from '@babel/core';
import { readInitialCoverage } from 'istanbul-lib-instrument';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const root = fileURLToPath(new URL('..', import.meta.url));
const MARK = '__COVERAGE__';
const PLUGINS = {
  'agent-router': { parts: ['.claude-plugin', 'agents', 'commands', 'hooks', 'lib', 'scripts', 'tests', 'package.json'] },
  keepalive: { parts: ['.claude-plugin', 'hooks', 'lib', 'scripts', 'tests', 'package.json'] },
};
const NODE_INCLUDE = ['shared/lib/**', 'scripts/sync-shared.mjs', 'agent-router/lib/**', 'agent-router/scripts/**', 'keepalive/lib/**', 'keepalive/scripts/**'];
const PLUGIN_COPIES = ['agent-router/lib/shared/', 'keepalive/lib/shared/'];
const NODE_TESTS = ['shared/tests/*.test.mjs', 'agent-router/tests/*.test.mjs', 'keepalive/tests/*.test.mjs'];

const KIT = `import * as kit from 'claude-code/testing';
export * from 'claude-code/testing';
const PULL = { command: '${MARK}', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } };
export const test = (name: string, ...rest: any[]) => {
  const body = rest.at(-1);
  const wrapped = async ($: any, on: any) => {
    await body($, on);
    try {
      const result = await $.command.run(PULL);
      if (result?.text) console.log('${MARK}' + result.text);
    } catch {}
  };
  return (kit.test as any)(name, ...(rest.length > 1 ? [rest[0], wrapped] : [wrapped]));
};
`;
const PULL_HOOK = `on('command.run', { command: '${MARK}' }, () => {
    const all = globalThis.__coverage__ || {};
    const hits = {};
    for (const [path, file] of Object.entries(all)) hits[path] = { s: file.s, f: file.f, b: file.b };
    return { text: JSON.stringify(hits) };
  });
  `;

function run(argv, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function files(directory, test) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path, test));
    else if (test(entry.name)) found.push(path);
  }
  return found;
}

async function instrument(source, target) {
  const code = await readFile(source, 'utf8');
  const result = await transformAsync(code, {
    filename: source, babelrc: false, configFile: false, sourceType: 'module', retainLines: true,
    presets: [['@babel/preset-typescript', { jsxPragma: 'h', onlyRemoveTypeImports: false }]],
    plugins: [['@babel/plugin-transform-react-jsx', { pragma: 'h', pragmaFrag: 'Fragment', runtime: 'classic' }],
      ['babel-plugin-istanbul', { coverageGlobalScope: 'globalThis', coverageGlobalScopeFunc: false }]],
  });
  let output = result.code;
  const initial = readInitialCoverage(output);
  if (!initial) throw new Error(`No coverage data for ${source}`);
  const start = output.indexOf('export function register(');
  if (start >= 0) {
    const body = output.indexOf(') {', start) + 3;
    output = `${output.slice(0, body)}\n  ${PULL_HOOK}${output.slice(body)}`;
  }
  await writeFile(target, output);
  return initial.coverageData;
}

async function pluginCoverage(name, fixtures) {
  const temporary = await mkdtemp(join(tmpdir(), `${name}-coverage-`));
  try {
    const plugin = join(temporary, 'plugin');
    const config = join(temporary, 'config');
    await mkdir(plugin, { recursive: true });
    await mkdir(config, { recursive: true });
    for (const part of PLUGINS[name].parts) await cp(join(root, name, part), join(plugin, part), { recursive: true });
    const initial = {};
    for (const source of await files(join(root, name, 'hooks'), file => /\.tsx?$/.test(file))) {
      const data = await instrument(source, join(plugin, relative(join(root, name), source)));
      const copy = relative(join(root, name), source).startsWith('hooks/shared/');
      const path = copy ? join(root, 'shared', 'hooks', relative(join(root, name, 'hooks', 'shared'), source)) : data.path;
      initial[data.path] = { ...data, reportAs: path };
    }
    for (const testFile of await files(join(plugin, 'tests'), file => /\.test\.tsx?$/.test(file))) {
      const text = await readFile(testFile, 'utf8');
      await writeFile(testFile, text.replace(/from 'claude-code\/testing'/g, `from './coverage-kit'`));
    }
    await writeFile(join(plugin, 'tests', 'coverage-kit.ts'), KIT);
    const manifestPath = join(plugin, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const [key, value] of Object.entries(fixtures)) if (manifest.userConfig[key]) manifest.userConfig[key].default = value;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', DISABLE_TELEMETRY: '1' };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const result = await run([process.env.CLAUDE_BINARY || 'claude', 'plugin', 'test', plugin], { env, cwd: temporary });
    const summary = `${result.stdout}\n${result.stderr}`.split('\n').filter(line => /^ *\d+ (pass|fail)$/.test(line)).map(line => line.trim()).join(', ');
    const failed = /\b[1-9]\d* fail\b/.test(summary) || result.code !== 0;
    const map = libCoverage.createCoverageMap({});
    for (const { reportAs, ...data } of Object.values(initial)) map.merge({ [reportAs]: { ...data, path: reportAs } });
    let pulls = 0;
    for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
      const at = line.indexOf(MARK);
      if (at < 0) continue;
      pulls++;
      const hits = JSON.parse(line.slice(at + MARK.length));
      for (const [path, counts] of Object.entries(hits)) {
        if (!initial[path]) continue;
        const { reportAs, ...data } = initial[path];
        map.merge({ [reportAs]: { ...data, path: reportAs, ...counts } });
      }
    }
    return { map, failed, summary, pulls, output: failed ? `${result.stdout}\n${result.stderr}` : '' };
  } finally {
    if (process.env.COVERAGE_KEEP) process.stdout.write(`kept ${temporary}\n`);
    else await rm(temporary, { recursive: true, force: true });
  }
}

async function nodeCoverage() {
  const directory = await mkdtemp(join(tmpdir(), 'node-coverage-'));
  try {
    const tests = [];
    for (const pattern of NODE_TESTS) {
      const [folder, glob] = [dirname(pattern), pattern.split('/').at(-1)];
      const suffix = glob.replace('*', '');
      for (const name of await readdir(join(root, folder))) if (name.endsWith(suffix)) tests.push(join(folder, name));
    }
    const argv = [process.execPath, join(root, 'node_modules', 'c8', 'bin', 'c8.js'), '--all', '--src', root,
      ...NODE_INCLUDE.flatMap(pattern => ['--include', pattern]), '--exclude', '**/tests/**',
      '--reporter', 'json', '--report-dir', directory, '--temp-directory', join(directory, 'tmp'),
      process.execPath, '--test', '--test-isolation=none', '--experimental-test-module-mocks', ...tests];
    const result = await run(argv, { cwd: root, env: process.env });
    const failed = result.code !== 0;
    const raw = JSON.parse(await readFile(join(directory, 'coverage-final.json'), 'utf8').catch(() => '{}'));
    const map = libCoverage.createCoverageMap({});
    for (const [path, data] of Object.entries(raw)) {
      const copy = PLUGIN_COPIES.find(prefix => relative(root, path).startsWith(prefix));
      const shared = copy ? join(root, 'shared', 'lib', relative(join(root, copy), path)) : path;
      map.merge({ [shared]: { ...data, path: shared } });
    }
    return { map, failed, output: failed ? `${result.stdout}\n${result.stderr}` : '', tests: tests.length };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const fixtures = {
  'agent-router': (await import(join(root, 'agent-router', 'tests', 'fixtures.mjs'))).modelOptions,
  keepalive: (await import(join(root, 'keepalive', 'tests', 'fixtures.mjs'))).upkeepOptions,
};
const only = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const parts = await Promise.all([
  only.length && !only.includes('node') ? null : nodeCoverage(),
  ...Object.keys(PLUGINS).map(name => only.length && !only.includes(name) ? null : pluginCoverage(name, fixtures[name])),
]);
const map = libCoverage.createCoverageMap({});
let broken = false;
const labels = ['node', ...Object.keys(PLUGINS)];
parts.forEach((part, index) => {
  if (!part) return;
  map.merge(part.map);
  const detail = labels[index] === 'node' ? `${part.tests} test files` : `${part.summary}, ${part.pulls} tests measured`;
  process.stdout.write(`${labels[index]}: ${part.failed ? 'FAILED' : 'passed'} (${detail})\n`);
  if (part.failed) { broken = true; process.stdout.write(part.output.slice(-4000)); }
});
const context = libReport.createContext({ dir: join(root, 'coverage'), coverageMap: map, defaultSummarizer: 'nested' });
reports.create(process.argv.includes('--quiet') ? 'text-summary' : 'text', { skipFull: true }).execute(context);
if (process.argv.includes('--html')) reports.create('html').execute(context);
reports.create('json-summary').execute(context);
if (process.argv.includes('--gaps')) {
  const want = process.argv.slice(2).find(arg => arg.startsWith('--file='))?.slice(7);
  for (const file of map.files().sort().filter(file => !want || relative(root, file).includes(want))) {
    const data = map.fileCoverageFor(file).toJSON();
    const lines = [];
    for (const [id, count] of Object.entries(data.s)) if (!count) lines.push(`stmt ${data.statementMap[id].start.line}`);
    for (const [id, count] of Object.entries(data.f)) if (!count) lines.push(`fn ${data.fnMap[id].name}@${data.fnMap[id].loc.start.line}`);
    const text = (await readFile(file, 'utf8').catch(() => '')).split('\n');
    const snippet = location => {
      const line = text[location.start.line - 1] ?? '';
      const end = location.end.line === location.start.line ? location.end.column : line.length;
      return line.slice(location.start.column, Math.max(location.start.column + 1, end)).trim().slice(0, 90);
    };
    for (const [id, counts] of Object.entries(data.b)) counts.forEach((count, arm) => {
      if (count) return;
      const branch = data.branchMap[id];
      const location = branch.locations[arm]?.start?.line ? branch.locations[arm] : branch.loc;
      lines.push(`branch ${branch.type}@${location.start.line}:${location.start.column}#${arm} «${snippet(branch.loc)}»${branch.locations[arm]?.start?.line ? ` arm «${snippet(branch.locations[arm])}»` : ''}`);
    });
    if (lines.length) process.stdout.write(`${relative(root, file)}:\n  ${lines.join('\n  ')}\n`);
  }
}
const total = map.getCoverageSummary();
const short = ['statements', 'branches', 'functions', 'lines'].filter(metric => total[metric].pct < 100);
if (short.length) process.stdout.write(`\nBelow 100%: ${short.map(metric => `${metric} ${total[metric].pct}%`).join(', ')}\n`);
process.exitCode = broken || short.length ? 1 : 0;
