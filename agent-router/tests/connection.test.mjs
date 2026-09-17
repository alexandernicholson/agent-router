import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchModels, normalizeBaseUrl } from '../lib/connection.mjs';
import { handleRequest } from '../lib/bridge.mjs';
import { modelOptions } from './fixtures.mjs';

async function withGateway(handler, run) {
  const server = createServer(handler);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

function catalog(response, payload = { data: [{ id: 'vendor/code-v1' }] }) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function discoveryCache(t, baseUrl, models) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-router-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'cache'));
  await writeFile(join(directory, 'cache', 'gateway-models.json'), JSON.stringify({ baseUrl, fetchedAt: Date.now(), models }));
  return { CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' };
}

test('explicit unauthenticated gateways discover models without credential headers', async () => {
  let request;
  await withGateway((req, res) => { request = req; catalog(res); }, async baseUrl => {
    assert.deepEqual(await fetchModels({ env: {}, baseUrl }), [{ id: 'vendor/code-v1' }]);
  });
  assert.equal(request.url, '/v1/models?limit=1000');
  assert.equal(request.headers['user-agent'], 'agent-router');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers['x-api-key'], undefined);
  assert.equal(request.headers.authorization, undefined);
});

test('supplied standard headers and nonempty case-insensitive overrides reach the gateway', async t => {
  const requests = [];
  await withGateway((req, res) => { requests.push(req.headers); catalog(res); }, async baseUrl => {
    const env = { ...await discoveryCache(t, baseUrl, []), ANTHROPIC_API_KEY: 'fake-api-key', ANTHROPIC_AUTH_TOKEN: 'fake-token' };
    await fetchModels({ env, baseUrl });
    await fetchModels({ baseUrl, env: {
      ...env,
      ANTHROPIC_CUSTOM_HEADERS: 'X-API-KEY: custom-key\naUtHoRiZaTiOn: Custom custom-token\nUSER-agent: custom-client\nAnthropic-Version: custom-version\nX-Gateway: custom-value\nx-api-key:  ',
    } });
  });
  assert.equal(requests[0]['x-api-key'], 'fake-api-key');
  assert.equal(requests[0].authorization, 'Bearer fake-token');
  assert.equal(requests[1]['x-api-key'], 'custom-key');
  assert.equal(requests[1].authorization, 'Custom custom-token');
  assert.equal(requests[1]['user-agent'], 'custom-client');
  assert.equal(requests[1]['anthropic-version'], 'custom-version');
  assert.equal(requests[1]['x-gateway'], 'custom-value');
});

test('pagination preserves base paths, encodes cursors and keeps the first exact model ID', async () => {
  const urls = [];
  await withGateway((req, res) => {
    urls.push(req.url);
    catalog(res, urls.length === 1
      ? { data: [{ id: 'vendor/code-v1', label: 'first' }], has_more: true, last_id: 'cursor /?&' }
      : { data: [{ id: 'vendor/code-v1', label: 'duplicate' }, { id: 'vendor/search-v1' }] });
  }, async baseUrl => {
    assert.deepEqual(await fetchModels({ env: {}, baseUrl: `${baseUrl}/gateway/v1///` }), [
      { id: 'vendor/code-v1', label: 'first' }, { id: 'vendor/search-v1' },
    ]);
  });
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1], 'http://localhost').pathname, '/gateway/v1/models');
  assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('after_id'), 'cursor /?&');
});

test('repeated pagination cursors are rejected instead of looping', async () => {
  let requests = 0;
  await withGateway((req, res) => {
    requests++;
    catalog(res, { data: [{ id: 'vendor/code-v1' }], has_more: true, last_id: 'same' });
  }, async baseUrl => {
    await assert.rejects(fetchModels({ env: {}, baseUrl }), /non-advancing/);
  });
  assert.equal(requests, 2);
});

test('redirects are refused without forwarding credentials or exposing response bodies', async () => {
  let targetRequests = 0;
  await withGateway((req, res) => { targetRequests++; catalog(res); }, async target => {
    await withGateway((req, res) => {
      res.writeHead(302, { location: `${target}/credential-target` });
      res.end('sensitive-response-body');
    }, async baseUrl => {
      await assert.rejects(fetchModels({ baseUrl, env: { ANTHROPIC_API_KEY: 'fake-secret-key' } }), error => {
        assert.match(error.message, /HTTP 302/);
        assert.doesNotMatch(error.message, /sensitive-response-body|fake-secret-key|credential-target/);
        return true;
      });
    });
  });
  assert.equal(targetRequests, 0);
});

test('invalid and credential-bearing URLs are rejected without exposing their contents', async () => {
  for (const baseUrl of [
    undefined, '', 'invalid-private-value', 'file:///private-value',
    'https://user:private-value@gateway.example', 'https://gateway.example?token=private-value',
    'https://gateway.example#private-value', 'https://gateway.example?', 'https://gateway.example#',
    'http://gateway.example', 'http://10.0.0.1', 'http://127.0.0.1.gateway.example',
  ]) {
    assert.throws(() => normalizeBaseUrl(baseUrl), error => {
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    });
    await assert.rejects(fetchModels({ env: {}, baseUrl }), error => {
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    });
  }
  assert.equal(normalizeBaseUrl('https://api.anthropic.com/'), 'https://api.anthropic.com');
  for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '[::1]']) {
    assert.equal(normalizeBaseUrl(`http://${host}:1234/gateway///`), `http://${host}:1234/gateway`);
  }
});

test('network failures and malformed responses never expose credentials or response bodies', async () => {
  await withGateway((req, res) => { req.socket.destroy(); }, async baseUrl => {
    await assert.rejects(fetchModels({ baseUrl, env: { ANTHROPIC_AUTH_TOKEN: 'fake-secret-token' } }), error => {
      assert.match(error.message, /failed or timed out/);
      assert.doesNotMatch(error.message, /fake-secret-token|127\.0\.0\.1/);
      return true;
    });
  });
  await withGateway((req, res) => { res.end('sensitive-response-body'); }, async baseUrl => {
    await assert.rejects(fetchModels({ env: {}, baseUrl }), error => {
      assert.match(error.message, /not valid JSON/);
      assert.doesNotMatch(error.message, /sensitive-response-body/);
      return true;
    });
    await assert.rejects(fetchModels({ baseUrl, env: { ANTHROPIC_CUSTOM_HEADERS: 'bad header: fake-secret-token' } }), error => {
      assert.match(error.message, /headers are invalid/);
      assert.doesNotMatch(error.message, /fake-secret-token/);
      return true;
    });
  });
});

test('gateway discovery merges native choices with fresh non-Claude endpoint models', async t => {
  const fresh = [{ id: 'vendor/code-v1' }, { id: 'gateway/claude-review', display_name: 'Fresh review' }];
  await withGateway((req, res) => catalog(res, { data: fresh }), async baseUrl => {
    const nativeOnly = { id: 'gateway/claude-research', display_name: 'Gateway research' };
    const env = await discoveryCache(t, `${baseUrl}/`, [
      { id: 'gateway/claude-review', display_name: 'Older review' }, nativeOnly, nativeOnly,
    ]);
    assert.deepEqual(await fetchModels({ env, baseUrl }), [...fresh, nativeOnly]);
  });
});

test('gateway discovery retains native choices when direct discovery is refused', async t => {
  await withGateway((req, res) => { res.writeHead(403); res.end(); }, async baseUrl => {
    const models = [{ id: 'gateway/claude-review', display_name: 'Native authenticated choice' }];
    const env = await discoveryCache(t, baseUrl, models);
    assert.deepEqual(await fetchModels({ env, baseUrl }), models);
  });
});

test('gateway discovery cache is ignored when the flag is disabled', async t => {
  await withGateway((req, res) => { res.writeHead(403); res.end(); }, async baseUrl => {
    const env = await discoveryCache(t, baseUrl, [{ id: 'gateway/claude-review' }]);
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '0';
    await assert.rejects(fetchModels({ env, baseUrl }), /HTTP 403/);
  });
});

test('gateway discovery cache stays bound to its endpoint path', async t => {
  await withGateway((req, res) => { res.writeHead(403); res.end(); }, async baseUrl => {
    const env = await discoveryCache(t, `${baseUrl}/first`, [{ id: 'gateway/claude-review' }]);
    await assert.rejects(fetchModels({ env, baseUrl: `${baseUrl}/second` }), /HTTP 403/);
  });
});

test('gateway discovery recovers from a corrupt optional cache through the endpoint', async t => {
  await withGateway((req, res) => catalog(res), async baseUrl => {
    const env = await discoveryCache(t, baseUrl, []);
    await writeFile(join(env.CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json'), '{');
    assert.deepEqual(await fetchModels({ env, baseUrl }), [{ id: 'vendor/code-v1' }]);
  });
});

test('gateway discovery cache is ignored after selecting a third-party provider', async t => {
  await withGateway((req, res) => { res.writeHead(403); res.end(); }, async baseUrl => {
    const env = await discoveryCache(t, baseUrl, [{ id: 'gateway/claude-review' }]);
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    await assert.rejects(fetchModels({ env, baseUrl }), /HTTP 403/);
  });
});

test('client-aware gateways bootstrap custom roles with a cold discovery cache', async t => {
  const standard = { id: 'claude-standard-v1' };
  const custom = { id: 'gateway/code-task-v1' };
  await withGateway((request, response) => {
    const isClaudeClient = /^claude-(?:code|cli)\//i.test(request.headers['user-agent'] || '');
    catalog(response, { data: isClaudeClient ? [standard, custom] : [standard] });
  }, async baseUrl => {
    const env = await discoveryCache(t, baseUrl, []);
    await rm(join(env.CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json'));
    const runtime = { ...env, ANTHROPIC_BASE_URL: baseUrl, CLAUDE_PLUGIN_DATA: join(env.CLAUDE_CONFIG_DIR, 'data') };
    const input = { action: 'bootstrap', session_id: 'cold-gateway', options: Object.fromEntries(Object.keys(modelOptions).map(key => [key, custom.id])) };
    const snapshot = await handleRequest(input, runtime);
    assert.equal(snapshot.active, true);
    assert.deepEqual(Object.values(snapshot.policy.roles).map(role => role.model), Array(5).fill(custom.id));
    await assert.rejects(handleRequest({ ...input, session_id: 'discovery-disabled' }, {
      ...runtime, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '0',
    }), /does not advertise/);
  });
});

test('refused discovery explains missing gateway credentials without forwarding login tokens', async t => {
  const key = 'gateway-key-test';
  const oauth = 'oauth-token-test';
  await withGateway((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    if (request.headers['x-api-key'] === key) catalog(response);
    else { response.writeHead(403); response.end(); }
  }, async baseUrl => {
    const env = { ...await discoveryCache(t, baseUrl, []), CLAUDE_CODE_OAUTH_TOKEN: oauth, OTHER_GATEWAY_KEY: key };
    await assert.rejects(fetchModels({ env, baseUrl }), error => {
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      assert.match(error.message, /ANTHROPIC_AUTH_TOKEN/);
      assert.doesNotMatch(error.message, /gateway-key-test|oauth-token-test/);
      return true;
    });
    assert.deepEqual(await fetchModels({ env: { ...env, ANTHROPIC_API_KEY: key }, baseUrl }), [{ id: 'vendor/code-v1' }]);
  });
});
