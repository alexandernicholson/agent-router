import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { ConfigRow, On, RenderInput, RenderNode } from 'claude-code';
import { VERSION } from '../lib/version.js';

tier('user');

const ID = 'keepalive-settings';
const props = { title: 'Keepalive settings', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} };
const pane: RenderInput<'Pane', 'terminal'> = { component: 'Pane', surface: 'terminal', requestId: ID, props };
const TTLS = ['default', '5m', '1h'];
const UPKEEP = ['off', 'warm', 'compact', 'warmcomp'];

function row(field: string, kind: ConfigRow['kind'], value: string, options?: string[]): ConfigRow {
  return { key: `owner.${field}`, label: field, kind, value, ...(options ? { options } : {}), provider: { plugin: 'keepalive@tools', tier: 'user' }, isLocked: false };
}

function world(on: On, extra: { auth?: 'bearer'; env?: Record<string, string>; latest?: string; stored?: Record<string, unknown>; storeFails?: boolean } = {}) {
  const state = {
    rows: [
      { key: 'theme', label: 'Theme', kind: 'enum', value: 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
      row('cache_ttl', 'choice', 'default', TTLS), row('subagent_cache_ttl', 'choice', 'default', TTLS), row('teammate_cache_ttl', 'choice', 'default', TTLS),
      row('cache_upkeep', 'choice', 'off', UPKEEP), row('teammate_cache_upkeep', 'choice', 'off', UPKEEP), row('keepalive_limit', 'text', 'default'),
      row('teammate_keepalive_limit', 'text', 'same'), row('compact_threshold', 'text', '100k'),
      row('unreported_ttl', 'choice', 'off', ['off', '5m', '15m', '30m', '45m', '1h']), row('unreported_ttl_models', 'text', ''), row('keepalive_price_url', 'text', ''),
    ] as ConfigRow[],
    writes: [] as [string, unknown][], deny: '', echo: undefined as string | undefined, listFailure: undefined as unknown, openFailure: '',
    placed: true, logs: [] as string[], closed: 0, store: new Map<string, unknown>(Object.entries(extra.stored ?? {})), onList: undefined as undefined | (() => Promise<void>), onSet: undefined as undefined | (() => Promise<void>),
  };
  const offline = () => { if (extra.storeFails) throw new Error('store offline'); };
  on('store.get', ($, e) => { offline(); return { value: state.store.get(e.key) }; });
  on('store.set', ($, e) => { offline(); state.store.set(e.key, e.value); return { value: undefined }; });
  on('store.delete', ($, e) => { offline(); state.store.delete(e.key); return { value: undefined }; });
  mock.env(on, extra.env ?? {});
  mock.clock(on);
  on('env.set', () => ({ value: undefined }));
  on('session.id', () => ({ value: 'settings-session' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('session.authorize', () => ({ value: extra.auth ? { handle: 'opaque', kind: extra.auth } : null }));
  on('settings.read', () => ({ value: {} }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.open', () => {
    if (state.openFailure) throw new Error(state.openFailure);
    return { value: state.placed ? { isPlaced: true } : { isPlaced: false, reason: 'the terminal is too narrow' } };
  });
  on('ui.close', () => { state.closed++; return { value: undefined }; });
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', ($, e) => { state.logs.push(e.text); return { value: undefined }; });
  on('agent.list', () => ({ value: [] }));
  on('ui.render', { component: 'Pane' }, ($, e) => $.ui.resolve(e).Text({ children: ['Someone else'] }));
  on('config.list', async () => {
    await state.onList?.();
    if (state.listFailure) throw state.listFailure;
    return { value: state.rows.map(item => ({ ...item })) };
  });
  on('config.set', async ($, e) => {
    state.writes.push([e.key, e.value]);
    await state.onSet?.();
    if (state.deny) return { deny: state.deny };
    state.rows.find(item => item.key === e.key)!.value = e.value;
    return { value: state.echo ?? e.value };
  });
  on('process.run', ($, e) => {
    const request = JSON.parse(e.init?.stdin || '{}');
    const output = request.action === 'cache-snapshot' ? { samples: [], resets: [], labels: [], routes: null }
      : request.action === 'version' ? { current: VERSION, latest: extra.latest ?? null, plugin: 'keepalive@tools', marketplace: 'tools' } : {};
    return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify(output) } };
  });
  return state;
}

const owned = (state: { rows: ConfigRow[] }, field: string) => state.rows.find(item => item.key === `owner.${field}`)!;
const run = ($: Engine, columns = 120) => $.command.run({ command: ID, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns } });
async function open($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false });
  await run($);
  return $.ui.render(pane);
}
const select = ($: Engine, key: string, value: string) => $.ui.select({ plugin: 'keepalive', key, requestId: ID, value });
const type = ($: Engine, text: string, key = 'keepalive-limit') => $.ui.input({ plugin: 'keepalive', key: `${key}-custom`, requestId: ID, text });

function text(node: RenderNode | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const props = 'props' in node ? node.props as { label?: string; value?: string; placeholder?: string; options?: { value: string; label?: string }[] } : {};
  const chosen = props.options?.find(option => option.value === props.value);
  const label = node.type === 'Button' ? String(props.label) : node.type === 'Select' ? chosen?.label ?? chosen?.value ?? '' : node.type === 'Input' ? props.placeholder ?? '' : '';
  return [label, ...('children' in node && Array.isArray(node.children) ? node.children.map(text) : [])].filter(Boolean).join(' ');
}
function find(node: RenderNode | undefined, type: string, key: string): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === type && 'props' in node && (node.props as { key?: string }).key === key) return node.props as Record<string, unknown>;
  if (!('children' in node) || !Array.isArray(node.children)) return undefined;
  for (const child of node.children) {
    const found = find(child, type, key);
    if (found) return found;
  }
  return undefined;
}
const labels = (node: RenderNode | undefined, key: string) => (find(node, 'Select', key)?.options as { label: string }[] | undefined)?.map(option => option.label);

test('the settings pane saves the TTLs, upkeep modes and keepalive limit new conversations start with', async ($, on) => {
  const state = world(on);
  const drawn = await open($);
  expect(labels(drawn, 'cache-ttl')).toEqual(['Default (5m)', '5m', '1h']);
  expect(labels(drawn, 'subagent-ttl')).toEqual(['Default (5m)', '5m', '1h']);
  expect(labels(drawn, 'teammate-ttl')).toEqual(['Default (5m)', '5m', '1h']);
  expect(labels(drawn, 'cache-upkeep')).toEqual(UPKEEP);
  expect(labels(drawn, 'teammate-upkeep')).toEqual(UPKEEP);
  expect(labels(drawn, 'keepalive-limit')).toEqual(['Default (priced)', 'Infinite', '1', '2', '3', '4', '6', '8', '12', '16', '24']);
  expect(labels(drawn, 'teammate-limit')).toEqual(['Same as above', 'Default (priced)', 'Infinite', '1', '2', '3', '4', '6', '8', '12', '16', '24']);
  expect(labels(drawn, 'compact-threshold')).toEqual(['25k', '50k', '100k (default)', '150k', '200k', '300k', '500k']);
  expect(text(drawn)).toContain('Default (priced): keepalives while cheaper than a rewrite.');
  await select($, 'cache-ttl', '1h');
  expect(owned(state, 'cache_ttl').value).toBe('1h');
  expect(text(await $.ui.render(pane))).toContain('Saved. New conversations start with this TTL.');
  await select($, 'cache-upkeep', 'warmcomp');
  expect(owned(state, 'cache_upkeep').value).toBe('warmcomp');
  expect(text(await $.ui.render(pane))).toContain('Saved. New sessions start in warmcomp; this one\'s mode button changes it here.');
  await select($, 'teammate-upkeep', 'warm');
  expect(owned(state, 'teammate_cache_upkeep').value).toBe('warm');
  expect(text(await $.ui.render(pane))).toContain('Saved. New split-pane teammates start in warm.');
  await select($, 'keepalive-limit', '3');
  expect(owned(state, 'keepalive_limit').value).toBe('3');
  expect(text(await $.ui.render(pane))).toContain('Saved. warm and warmcomp use it after the next request.');
  await select($, 'keepalive-limit', 'infinite');
  expect(owned(state, 'keepalive_limit').value).toBe('infinite');
  await select($, 'teammate-limit', '6');
  expect(owned(state, 'teammate_keepalive_limit').value).toBe('6');
  expect(text(await $.ui.render(pane))).toContain('Saved. New split-pane teammates use it.');
  await select($, 'compact-threshold', '50k');
  expect(owned(state, 'compact_threshold').value).toBe('50k');
  expect(text(await $.ui.render(pane))).toContain('Saved. compact and warmcomp compact conversations of 50k tokens or more.');
  expect(state.writes.map(([key]) => key)).toEqual(['owner.cache_ttl', 'owner.cache_upkeep', 'owner.teammate_cache_upkeep', 'owner.keepalive_limit',
    'owner.keepalive_limit', 'owner.teammate_keepalive_limit', 'owner.compact_threshold']);
});

test('each default names what Claude Code would use, with split-pane and in-process teammates apart when they differ', async ($, on) => {
  world(on, { auth: 'bearer' });
  const drawn = await open($);
  expect(labels(drawn, 'cache-ttl')?.[0]).toBe('Default (1h)');
  expect(labels(drawn, 'subagent-ttl')?.[0]).toBe('Default (5m)');
  expect(labels(drawn, 'teammate-ttl')?.[0]).toBe('Default (1h split-pane, 5m in-process)');
});

test('any whole number can be typed as the keepalive limit, and anything else is refused', async ($, on) => {
  const state = world(on);
  await open($);
  await type($, ' 37 ');
  expect(owned(state, 'keepalive_limit').value).toBe('37');
  const drawn = await $.ui.render(pane);
  expect(labels(drawn, 'keepalive-limit')?.at(-1)).toBe('37');
  for (const bad of ['0', '-2', '1.5', 'lots', '99999999999999999999']) {
    await type($, bad);
    expect(text(await $.ui.render(pane))).toContain('Type default, infinite, or a whole number of keepalives from 1.');
  }
  expect(state.writes).toHaveLength(1);
  await type($, ' Infinite ');
  expect(owned(state, 'keepalive_limit').value).toBe('infinite');
});

test('a teammate limit can be typed, including same, and anything else is refused', async ($, on) => {
  const state = world(on);
  await open($);
  await type($, '9', 'teammate-limit');
  expect(owned(state, 'teammate_keepalive_limit').value).toBe('9');
  await type($, 'later', 'teammate-limit');
  expect(text(await $.ui.render(pane))).toContain('Type same, default, infinite, or a whole number of keepalives from 1.');
  await type($, ' SAME ', 'teammate-limit');
  expect(owned(state, 'teammate_keepalive_limit').value).toBe('same');
  expect(state.writes).toHaveLength(2);
});

test('any number of tokens can be typed as the compaction threshold, in thousands or millions, and anything else is refused', async ($, on) => {
  const state = world(on);
  await open($);
  for (const [typed, saved] of [[' 80000 ', '80k'], ['75k', '75k'], ['1M', '1000k'], ['12345', '12345']]) {
    await type($, typed, 'compact-threshold');
    expect(owned(state, 'compact_threshold').value).toBe(saved);
  }
  expect(labels(await $.ui.render(pane), 'compact-threshold')?.at(-1)).toBe('12345');
  for (const bad of ['0', '-5k', '1.5k', '80 k', 'big', '99999999999999m']) {
    await type($, bad, 'compact-threshold');
    expect(text(await $.ui.render(pane))).toContain('Type a number of tokens, such as 80k or 80000.');
  }
  expect(state.writes).toHaveLength(4);
});

test('a limit set elsewhere that is not a number is shown, but choosing it again writes nothing', async ($, on) => {
  const state = world(on);
  owned(state, 'keepalive_limit').value = 'lots';
  const drawn = await open($);
  expect(labels(drawn, 'keepalive-limit')?.at(-1)).toBe('lots');
  await select($, 'keepalive-limit', 'lots');
  expect(state.writes).toHaveLength(0);
});

test('settings your administrator manages are shown without controls and never written', async ($, on) => {
  const state = world(on);
  owned(state, 'cache_ttl').isLocked = true;
  Object.assign(owned(state, 'keepalive_limit'), { isLocked: true, value: '3' });
  const drawn = await open($);
  expect(find(drawn, 'Select', 'cache-ttl')).toBeUndefined();
  expect(find(drawn, 'Input', 'keepalive-limit-custom')).toBeUndefined();
  expect(find(drawn, 'Input', 'compact-threshold-custom')).toBeDefined();
  expect(text(drawn)).toContain('Main conversation Default (5m) · managed by your administrator');
  expect(text(drawn)).toContain('Keepalive limit 3 · managed by your administrator');
  owned(state, 'teammate_cache_upkeep').isLocked = true;
  await select($, 'teammate-upkeep', 'warm');
  expect(state.writes).toHaveLength(0);
  expect(text(await $.ui.render(pane))).toContain('Your administrator manages this setting. Ask them to update the teammate upkeep.');
});

test('an option withdrawn since the pane was drawn is not written', async ($, on) => {
  const state = world(on);
  await open($);
  owned(state, 'cache_ttl').options = ['default', '5m'];
  await select($, 'cache-ttl', '1h');
  expect(state.writes).toHaveLength(0);
  expect(owned(state, 'cache_ttl').value).toBe('default');
});

test('a refused or altered write says why and leaves the pane ready to retry', async ($, on) => {
  const state = world(on);
  await open($);
  state.deny = 'Managed write refused';
  await select($, 'cache-ttl', '1h');
  expect(text(await $.ui.render(pane))).toContain('Managed write refused');
  state.deny = '';
  state.echo = '5m';
  await select($, 'cache-ttl', '1h');
  expect(text(await $.ui.render(pane))).toContain('The config writer returned a different value. Open /config to inspect the saved setting.');
  state.echo = undefined;
  await select($, 'cache-ttl', '1h');
  const drawn = await $.ui.render(pane);
  expect(text(drawn)).not.toContain('The config writer returned');
  expect(find(drawn, 'Select', 'cache-ttl')?.value).toBe('1h');
});

test('a missing, duplicated or retyped setting points to /config instead of drawing a control', async ($, on) => {
  const state = world(on);
  state.rows = state.rows.filter(item => item.key !== 'owner.subagent_cache_ttl' && item.key !== 'owner.keepalive_limit');
  state.rows.push({ ...owned(state, 'teammate_cache_ttl'), provider: { plugin: 'keepalive', tier: 'user' } });
  owned(state, 'teammate_cache_upkeep').kind = 'text';
  const drawn = await open($);
  expect(text(drawn)).toContain('Open /config and check that subagent_cache_ttl has one visible Keepalive setting.');
  expect(text(drawn)).toContain('Open /config and check that teammate_cache_ttl has one visible Keepalive setting.');
  expect(text(drawn)).toContain('Open /config to edit teammate_cache_upkeep; this setting requires its native control.');
  expect(text(drawn)).toContain('Open /config and check that keepalive_limit has one visible Keepalive setting.');
  expect(find(drawn, 'Input', 'keepalive-limit-custom')).toBeUndefined();
  state.rows = state.rows.filter(item => item.key !== 'owner.cache_ttl');
  await select($, 'cache-ttl', '1h');
  expect(state.writes).toHaveLength(0);
  expect(text(await $.ui.render(pane))).toContain('Open /config and check that cache_ttl has one visible Keepalive setting.');
});

test('the pane says when settings are unavailable, and a stale choice made then writes nothing', async ($, on) => {
  const state = world(on);
  await open($);
  state.listFailure = new Error('config offline');
  await run($);
  const drawn = await $.ui.render(pane);
  expect(text(drawn)).toContain('Loading settings…');
  expect(text(drawn)).toContain('Settings unavailable: ');
  state.listFailure = undefined;
  await run($);
  await $.ui.render(pane);
  await select($, 'cache-ttl', '1h');
  state.listFailure = new Error('config offline');
  await run($);
  await select($, 'subagent-ttl', '1h');
  expect(state.writes.map(([key]) => key)).toEqual(['owner.cache_ttl']);
});

test('the settings pane opens only where it fits, and says why when it cannot', async ($, on) => {
  const state = world(on);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false });
  expect((await run($, 60)).text).toBe('Widen the terminal to at least 70 columns, then run /keepalive-settings.');
  state.placed = false;
  expect((await run($)).text).toBeUndefined();
  expect(state.logs).toContain('Keepalive settings: the terminal is too narrow');
  state.openFailure = 'pane refused';
  expect((await run($)).text).toStartWith('Keepalive settings: ');
});

test('other surfaces are pointed to the terminal or desktop, and Close closes the pane', async ($, on) => {
  const state = world(on);
  await open($);
  const elsewhere = await $.ui.render({ ...pane, surface: 'vscode' } as RenderInput<'Pane', 'vscode'>);
  expect(text(elsewhere)).toContain('Open /keepalive-settings in the terminal or desktop to change these settings.');
  await $.ui.press({ plugin: 'keepalive', key: 'close', requestId: ID, surface: 'vscode' });
  expect(state.closed).toBe(1);
  await run($);
  expect(find(await $.ui.render({ ...pane, surface: 'desktop' } as RenderInput<'Pane', 'desktop'>), 'Select', 'cache-ttl')).toBeDefined();
  await $.ui.press({ plugin: 'keepalive', key: 'close', requestId: ID, surface: 'desktop' });
  expect(state.closed).toBe(2);
  await $.ui.select({ plugin: 'keepalive', key: 'cache-ttl', requestId: ID, value: '1h', surface: 'desktop' });
  expect(state.writes).toHaveLength(0);
});

test('while a choice is saving the pane shows values without controls, and a second choice is ignored', async ($, on) => {
  const state = world(on);
  await open($);
  let reached!: () => void;
  let release!: () => void;
  const atSet = new Promise<void>(resolve => { reached = resolve; });
  state.onSet = () => { state.onSet = undefined; reached(); return new Promise<void>(resolve => { release = resolve; }); };
  const first = select($, 'cache-ttl', '1h');
  await atSet;
  await select($, 'subagent-ttl', '1h');
  await type($, '5');
  const during = await $.ui.render(pane);
  release();
  await first;
  expect(text(during)).toContain('Main conversation Default (5m)');
  expect(find(during, 'Select', 'cache-ttl')).toBeUndefined();
  expect(find(during, 'Input', 'keepalive-limit-custom')).toBeUndefined();
  expect(state.writes.map(([key]) => key)).toEqual(['owner.cache_ttl']);
});

const closer = { name: 'closer', register(on: On) {
  on('command.run', { command: 'close-settings' }, async $ => { await $.ui.close({ id: 'keepalive-settings' }); return { text: 'closed' }; });
} };

test('closing the pane while a choice is being checked drops the choice', { plugins: [closer] }, async ($, on) => {
  const state = world(on);
  await open($);
  let reached!: () => void;
  let release!: () => void;
  const atList = new Promise<void>(resolve => { reached = resolve; });
  state.onList = () => { state.onList = undefined; reached(); return new Promise<void>(resolve => { release = resolve; }); };
  const chosen = select($, 'cache-ttl', '1h');
  await atList;
  await $.command.run({ command: 'close-settings', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });
  release();
  await chosen;
  expect(state.closed).toBe(1);
  expect(state.writes).toHaveLength(0);
});

test('the settings command waits for session setup, and other panes are left to their owners', async ($, on) => {
  world(on);
  expect((await run($)).text).toBe('Run /keepalive-settings after session setup completes.');
  expect(text(await $.ui.render(pane))).toBe('Someone else');
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false });
  expect(text(await $.ui.render({ ...pane, requestId: 'other' }))).toBe('Someone else');
});

test('the settings pane sets the TTL for models that report none, per-model overrides and the price feed', async ($, on) => {
  const state = world(on);
  const drawn = await open($);
  expect(labels(drawn, 'unreported-ttl')).toEqual(['Off (monitor only)', '5m', '15m', '30m', '45m', '1h']);
  expect(text(drawn)).toContain('never for Claude');
  expect(text(drawn)).toContain('Price feed your gateway');
  await select($, 'unreported-ttl', '15m');
  expect(owned(state, 'unreported_ttl').value).toBe('15m');
  expect(text(await $.ui.render(pane))).toContain('are kept warm for 15m');
  await select($, 'unreported-ttl', 'off');
  expect(text(await $.ui.render(pane))).toContain('are monitored only');
  await type($, 'kimi*=15m, glm-5.3=off', 'unreported-ttl-models');
  expect(owned(state, 'unreported_ttl_models').value).toBe('kimi*=15m, glm-5.3=off');
  expect(text(await $.ui.render(pane))).toContain('Saved. The per-model TTLs apply');
  await type($, 'nonsense', 'unreported-ttl-models');
  expect(text(await $.ui.render(pane))).toContain('Type model=ttl pairs');
  await type($, 'https://prices.example/p.json', 'price-url');
  expect(owned(state, 'keepalive_price_url').value).toBe('https://prices.example/p.json');
  expect(text(await $.ui.render(pane))).toContain('Saved. The next price lookup uses it.');
  expect(text(await $.ui.render(pane))).toContain('Price feed https://prices.example/p.json');
  await type($, 'ftp://x', 'price-url');
  expect(text(await $.ui.render(pane))).toContain('Type an https:// URL, off, or nothing');
});

test('a missing price feed setting is reported in the pane instead of breaking it', async ($, on) => {
  const state = world(on);
  state.rows = state.rows.filter(item => !item.key.endsWith('.keepalive_price_url'));
  expect(text(await open($))).toContain('Price feed unavailable');
});

test('the settings pane names its version in the top right, and a newer one adds a button that says how to update', async ($, on) => {
  const current = world(on);
  const drawn = await open($);
  expect(text(drawn).startsWith(`Keepalive settings Keepalive ${VERSION}`)).toBe(true);
  expect(find(drawn, 'Button', 'keepalive-update')).toBe(undefined);
  expect(current.logs).toEqual([]);
});

test('a newer version shows in the settings pane header, and pressing it says how to update', async ($, on) => {
  const state = world(on, { latest: '9.9.9' });
  const drawn = await open($);
  expect(find(drawn, 'Button', 'keepalive-update')?.label).toBe('⬆ 9.9.9 available');
  await $.ui.press({ plugin: 'keepalive', key: 'keepalive-update', requestId: ID });
  expect(state.logs).toContain('Keepalive 9.9.9 is available. Run /plugin marketplace update tools, then /plugin install keepalive@tools and /reload-plugins.');
});

function trail(node: RenderNode | undefined, type: string, key: string, path: RenderNode[] = []): RenderNode[] | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === type && 'props' in node && (node.props as { key?: string }).key === key) return [...path, node];
  if (!('children' in node) || !Array.isArray(node.children)) return undefined;
  for (const child of node.children) {
    const found = trail(child, type, key, [...path, node]);
    if (found) return found;
  }
  return undefined;
}

test('every text field is drawn as a box on its own setting\'s row, after the label and the current value', async ($, on) => {
  world(on);
  const drawn = await open($);
  const rows = { 'keepalive-limit': 'Keepalive limit Default (priced)', 'teammate-limit': 'Teammate limit Same as above',
    'compact-threshold': 'Compact from 100k (default)', 'unreported-ttl-models': 'Per model None', 'price-url': 'Price feed your gateway' };
  for (const [key, row] of Object.entries(rows)) {
    const path = trail(drawn, 'Input', `${key}-custom`)!;
    const box = path.at(-2) as { props: { borderStyle?: string } };
    expect([key, box.props.borderStyle]).toEqual([key, 'round']);
    expect([key, text(path.at(-3)).startsWith(row)]).toEqual([key, true]);
  }
  expect(text(drawn)).toContain('Type into a boxed field and press Enter to save it.');
});

test('after Claude Code reloads Keepalive for a saved setting, the open settings pane draws itself again with what was saved', async ($, on) => {
  const state = world(on, { stored: { 'settings-notice': 'Saved. New conversations start with this TTL.' } });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false });
  let drawn = await $.ui.render(pane);
  expect(text(drawn)).toContain('Loading settings…');
  for (let tries = 0; tries < 20 && text(drawn).includes('Loading settings…'); tries++) drawn = await $.ui.render(pane);
  expect(text(drawn)).toContain('Saved. New conversations start with this TTL.');
  expect(labels(drawn, 'cache-ttl')).toEqual(['Default (5m)', '5m', '1h']);
  expect(state.store.has('settings-notice')).toBe(false);
});

test('opening the settings pane yourself never shows a notice left from an earlier save', async ($, on) => {
  const state = world(on, { stored: { 'settings-notice': 'Saved. New conversations start with this TTL.' } });
  const drawn = await open($);
  expect(text(drawn)).not.toContain('Saved.');
  expect(state.store.has('settings-notice')).toBe(false);
  await select($, 'cache-ttl', '1h');
  expect(state.store.get('settings-notice')).toBe('Saved. New conversations start with this TTL.');
});

test('a store that cannot be read or written never stops the settings pane from drawing or saving', async ($, on) => {
  const state = world(on, { storeFails: true });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false });
  let drawn = await $.ui.render(pane);
  for (let tries = 0; tries < 20 && text(drawn).includes('Loading settings…'); tries++) drawn = await $.ui.render(pane);
  expect(labels(drawn, 'cache-ttl')).toEqual(['Default (5m)', '5m', '1h']);
  await select($, 'cache-ttl', '1h');
  expect(text(await $.ui.render(pane))).toContain('Saved. New conversations start with this TTL.');
  expect(owned(state, 'cache_ttl').value).toBe('1h');
});
