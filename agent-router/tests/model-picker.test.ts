import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { ConfigRow, On, RenderInput, RenderNode } from 'claude-code';

tier('user');

const pane: RenderInput<'Pane', 'terminal'> = {
  component: 'Pane', surface: 'terminal', requestId: 'agent-models',
  props: { title: 'Models', isFocused: true, bodyColumns: 76, placement: 'inline', scroll: { offset: 0, bodyRows: 24 }, view: {} },
};

function world(on: On, models = [{ id: 'vendor/selected', name: 'Selected model', description: 'Catalog choice' }]) {
  const fields = ['scout_model', 'reviewer_model', 'security_reviewer_model', 'task_model', 'sonic_model'];
  const rows: ConfigRow[] = fields.map(field => ({ key: `actual-owner.${field}`, label: field,
    kind: 'text', value: '', provider: { plugin: 'agent-router@agent-router-tools', tier: 'user' }, isLocked: false }));
  const efforts = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
  for (const field of fields) rows.push({ key: `actual-owner.${field.replace(/_model$/, '_effort')}`, label: field,
    kind: 'choice', value: 'default', options: efforts, provider: { plugin: 'agent-router@agent-router-tools', tier: 'user' }, isLocked: false });
  rows.push({ key: 'actual-owner.teammate_model', label: 'teammate_model', kind: 'text', value: '',
    provider: { plugin: 'agent-router@agent-router-tools', tier: 'user' }, isLocked: false });
  rows.push({ key: 'actual-owner.teammate_effort', label: 'teammate_effort', kind: 'choice', value: 'default', options: efforts,
    provider: { plugin: 'agent-router@agent-router-tools', tier: 'user' }, isLocked: false });
  rows.push({ key: 'actual-owner.teammate_cache_upkeep', label: 'teammate_cache_upkeep', kind: 'choice', value: 'off', options: ['off', 'warm', 'compact', 'warmcomp'],
    provider: { plugin: 'agent-router@agent-router-tools', tier: 'user' }, isLocked: false });
  for (const field of ['cache_ttl', 'subagent_cache_ttl', 'teammate_cache_ttl']) rows.push({ key: `actual-owner.${field}`, label: field, kind: 'choice', value: 'default',
    options: ['default', '5m', '1h'], provider: { plugin: 'agent-router@agent-router-tools', tier: 'user' }, isLocked: false });
  // Similarly named foreign rows must never receive the selection.
  rows.push({ ...rows[rows.length - 5], key: 'foreign.scout_effort', provider: { plugin: 'foreign', tier: 'user' } });
  rows.unshift({ ...rows[0], key: 'foreign.scout_model', provider: { plugin: 'foreign', tier: 'user' } });
  rows.push({ key: 'actual-owner.keepalive_limit', label: 'keepalive_limit', kind: 'text', value: 'default',
    provider: { plugin: 'agent-router@agent-router-tools', tier: 'user' }, isLocked: false });
  const state = { rows, writes: 0, deny: '', opened: 0, catalogError: '', openArgs: undefined as Record<string, unknown> | undefined, squeezed: '', logs: [] as string[] };
  mock.store(on);
  mock.env(on, {});
  on('session.id', () => ({ value: 'picker-session' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.open', ($, e) => {
    state.opened++; state.openArgs = { ...e };
    return { value: state.squeezed ? { isPlaced: false, reason: state.squeezed } : { isPlaced: true } };
  });
  on('ui.close', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', ($, e) => { state.logs.push(e.text); return { value: undefined }; });
  on('config.list', () => ({ value: state.rows }));
  on('config.set', ($, e) => {
    state.writes++;
    if (state.deny) return { deny: state.deny };
    const row = state.rows.find(item => item.key === e.key)!;
    row.value = e.value;
    return { value: row.value };
  });
  on('process.run', ($, e) => {
    const request = JSON.parse(e.init?.stdin || '{}');
    if (request.action === 'catalog' && state.catalogError) {
      return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 1, stderr: state.catalogError, stdout: '' } };
    }
    return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify(request.action === 'catalog'
      ? { endpoint: 'https://gateway.example', models }
      : { active: false, policy: null, digest: null, gateway: null, sessionId: 'picker-session' }) } };
  });
  return state;
}

async function open($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'agent-models', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });
  await $.ui.render(pane);
}

test('model selection rechecks administrative locks after the catalog was drawn', async ($, on) => {
  const state = world(on);
  await open($);
  state.rows[1].isLocked = true;
  await $.ui.press({ plugin: 'agent-router', key: 'model:vendor/selected', requestId: 'agent-models' });
  expect(state.writes).toBe(0);
  expect(state.rows[1].value).toBe('');
});

test('denied selections remain retryable and successful selections persist only the owned role', async ($, on) => {
  const state = world(on);
  state.deny = 'Managed write refused';
  await open($);
  await $.ui.press({ plugin: 'agent-router', key: 'model:vendor/selected', requestId: 'agent-models' });
  expect(state.rows[1].value).toBe('');
  state.deny = '';
  await $.ui.render(pane);
  await $.ui.press({ plugin: 'agent-router', key: 'model:vendor/selected', requestId: 'agent-models' });
  expect(state.rows[0].value).toBe('');
  expect(state.rows[1].value).toBe('vendor/selected');
  expect(state.rows[2].value).toBe('');
  const opened = state.opened;
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(state.opened).toBe(opened + 1);
  await $.ui.render(pane);
  await $.ui.press({ plugin: 'agent-router', key: 'model:vendor/selected', requestId: 'agent-models' });
  expect(state.rows[2].value).toBe('vendor/selected');
  await $.ui.render(pane);
  await $.ui.press({ plugin: 'agent-router', key: 'close', requestId: 'agent-models' });
  const closed = state.opened;
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(state.opened).toBe(closed);
});

test('catalog navigation selects models across full and partial pages', async ($, on) => {
  const state = world(on, Array.from({ length: 7 }, (_, index) => ({
    id: `vendor/page-${index + 1}`, name: `Choice ${index + 1}`, description: '',
  })));
  await open($);
  await $.ui.press({ plugin: 'agent-router', key: 'previous', requestId: 'agent-models' });
  await $.ui.render(pane);
  await $.ui.press({ plugin: 'agent-router', key: 'model:vendor/page-7', requestId: 'agent-models' });
  expect(state.rows[1].value).toBe('vendor/page-7');
  await $.ui.render(pane);
  await $.ui.press({ plugin: 'agent-router', key: 'next', requestId: 'agent-models' });
  await $.ui.render(pane);
  await $.ui.press({ plugin: 'agent-router', key: 'next', requestId: 'agent-models' });
  await $.ui.render(pane);
  await $.ui.press({ plugin: 'agent-router', key: 'previous', requestId: 'agent-models' });
  await $.ui.render(pane);
  await $.ui.press({ plugin: 'agent-router', key: 'model:vendor/page-4', requestId: 'agent-models' });
  expect(state.rows[2].value).toBe('vendor/page-4');
});

function text(node: RenderNode): string {
  if (typeof node === 'string') return node;
  return 'children' in node && Array.isArray(node.children) ? node.children.map(text).join(' ') : '';
}

test('catalog refusal preserves saved settings and refresh can recover', async ($, on) => {
  const state = world(on);
  state.rows[1].value = 'vendor/current';
  state.catalogError = 'Model discovery returned HTTP 403';
  await open($);
  const failed = text(await $.ui.render(pane));
  expect(failed.includes('vendor/current')).toBe(true);
  expect(failed.includes('HTTP 403')).toBe(true);
  state.catalogError = '';
  await $.ui.press({ plugin: 'agent-router', key: 'refresh', requestId: 'agent-models' });
  await $.ui.render(pane);
  await $.ui.press({ plugin: 'agent-router', key: 'model:vendor/selected', requestId: 'agent-models' });
  expect(state.rows[1].value).toBe('vendor/selected');
});

test('the picker requests a dock width wide enough for its controls', async ($, on) => {
  const state = world(on);
  await open($);
  expect(state.opened).toBe(1);
  expect(state.openArgs?.rows).toBe(24);
  expect(typeof state.openArgs?.columns).toBe('number');
  expect((state.openArgs?.columns as number) >= 110).toBe(true);
});

test('an unplaced picker pane tells the person why it waits', async ($, on) => {
  const state = world(on);
  state.squeezed = 'the terminal is 100 columns wide; 110 seats it';
  await open($);
  expect(state.opened).toBe(1);
  expect(state.logs.some(log => log.includes(state.squeezed))).toBe(true);
});

function hasSelect(node: RenderNode, key: string): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if ('type' in node && node.type === 'Select' && 'props' in node && (node.props as { key?: string }).key === key) return true;
  return 'children' in node && Array.isArray(node.children) && node.children.some(child => hasSelect(child, key));
}

test('effort selection writes only the owned effort row for the current role', async ($, on) => {
  const state = world(on);
  await open($);
  expect(hasSelect(await $.ui.render(pane), 'effort')).toBe(true);
  await $.ui.select({ plugin: 'agent-router', key: 'effort', requestId: 'agent-models', value: 'high' });
  expect(state.rows.find(row => row.key === 'actual-owner.scout_effort')?.value).toBe('high');
  expect(state.rows.find(row => row.key === 'foreign.scout_effort')?.value).toBe('default');
  expect(state.rows.find(row => row.key === 'actual-owner.reviewer_effort')?.value).toBe('default');
});

test('locked effort rows are shown but never written', async ($, on) => {
  const state = world(on);
  state.rows.find(row => row.key === 'actual-owner.scout_effort')!.isLocked = true;
  await open($);
  const drawn = await $.ui.render(pane);
  expect(hasSelect(drawn, 'effort')).toBe(false);
  expect(text(drawn).includes('managed by your administrator')).toBe(true);
  expect(state.writes).toBe(0);
  expect(state.rows.find(row => row.key === 'actual-owner.scout_effort')?.value).toBe('default');
});

test('the Teammates entry saves a teammate model and effort, and default clears the override', async ($, on) => {
  const state = world(on);
  for (const row of state.rows) if (row.kind === 'text' && row.key.startsWith('actual-owner.') && row.key !== 'actual-owner.teammate_model') row.value = 'vendor/selected';
  await open($);
  await $.ui.render(pane);
  await $.ui.select({ plugin: 'agent-router', key: 'role', requestId: 'agent-models', value: 'teammate_model' });
  const drawn = await $.ui.render(pane);
  expect(text(drawn).includes('each role')).toBe(true);
  await $.ui.press({ plugin: 'agent-router', key: 'model:vendor/selected', requestId: 'agent-models' });
  expect(state.rows.find(row => row.key === 'actual-owner.teammate_model')?.value).toBe('vendor/selected');
  await $.ui.render(pane);
  await $.ui.select({ plugin: 'agent-router', key: 'effort', requestId: 'agent-models', value: 'high' });
  expect(state.rows.find(row => row.key === 'actual-owner.teammate_effort')?.value).toBe('high');
  await $.ui.render(pane);
  await $.ui.press({ plugin: 'agent-router', key: 'teammate-default', requestId: 'agent-models' });
  expect(state.rows.find(row => row.key === 'actual-owner.teammate_model')?.value).toBe('');
  expect(state.rows.find(row => row.key === 'foreign.scout_model')?.value).toBe('');
});

test('an unset teammate override never blocks the role setup flow', async ($, on) => {
  const state = world(on);
  await open($);
  for (let index = 0; index < 5; index++) {
    await $.ui.render(pane);
    await $.ui.press({ plugin: 'agent-router', key: 'model:vendor/selected', requestId: 'agent-models' });
  }
  const roles = state.rows.filter(row => row.kind === 'text' && row.key.startsWith('actual-owner.') && row.key !== 'actual-owner.teammate_model' && row.key !== 'actual-owner.keepalive_limit');
  expect(roles.every(row => row.value === 'vendor/selected')).toBe(true);
  expect(state.rows.find(row => row.key === 'actual-owner.teammate_model')?.value).toBe('');
});

test('the Teammates entry saves the cache upkeep teammates start in', async ($, on) => {
  const state = world(on);
  await open($);
  expect(hasSelect(await $.ui.render(pane), 'teammate-upkeep')).toBe(false);
  await $.ui.select({ plugin: 'agent-router', key: 'role', requestId: 'agent-models', value: 'teammate_model' });
  const drawn = await $.ui.render(pane);
  expect(hasSelect(drawn, 'teammate-upkeep')).toBe(true);
  expect(text(drawn).includes('Split-pane teammates start in this cache upkeep')).toBe(true);
  await $.ui.select({ plugin: 'agent-router', key: 'teammate-upkeep', requestId: 'agent-models', value: 'warmcomp' });
  expect(state.rows.find(row => row.key === 'actual-owner.teammate_cache_upkeep')?.value).toBe('warmcomp');
  expect(state.rows.find(row => row.key === 'actual-owner.teammate_effort')?.value).toBe('default');
});

test('a locked teammate upkeep row is shown but never written', async ($, on) => {
  const state = world(on);
  state.rows.find(row => row.key === 'actual-owner.teammate_cache_upkeep')!.isLocked = true;
  await open($);
  await $.ui.select({ plugin: 'agent-router', key: 'role', requestId: 'agent-models', value: 'teammate_model' });
  const drawn = await $.ui.render(pane);
  expect(hasSelect(drawn, 'teammate-upkeep')).toBe(false);
  expect(text(drawn).includes('Cache upkeep: off · managed by your administrator')).toBe(true);
  expect(state.writes).toBe(0);
});

function selectOptions(node: RenderNode, key: string): { value: string; label: string }[] | undefined {
  if (typeof node === 'string') return undefined;
  if (node.type === 'Select' && node.props.key === key) return node.props.options as { value: string; label: string }[];
  if ('children' in node && Array.isArray(node.children)) for (const child of node.children) {
    const found = selectOptions(child, key);
    if (found) return found;
  }
  return undefined;
}

test('the Prompt cache entry saves the default TTL of the main conversation and of subagents', async ($, on) => {
  const state = world(on);
  await open($);
  await $.ui.select({ plugin: 'agent-router', key: 'role', requestId: 'agent-models', value: 'cache_ttl' });
  const drawn = await $.ui.render(pane);
  expect(selectOptions(drawn, 'cache-ttl')?.map(option => option.label)).toEqual(['Default (5m)', '5m', '1h']);
  expect(selectOptions(drawn, 'subagent-ttl')?.map(option => option.label)).toEqual(['Default (5m)', '5m', '1h']);
  expect(text(drawn).includes('Default is what Claude Code uses')).toBe(true);
  await $.ui.select({ plugin: 'agent-router', key: 'cache-ttl', requestId: 'agent-models', value: '1h' });
  await $.ui.render(pane);
  await $.ui.select({ plugin: 'agent-router', key: 'subagent-ttl', requestId: 'agent-models', value: '5m' });
  expect(state.rows.find(row => row.key === 'actual-owner.cache_ttl')?.value).toBe('1h');
  expect(state.rows.find(row => row.key === 'actual-owner.subagent_cache_ttl')?.value).toBe('5m');
  expect(state.rows.find(row => row.key === 'actual-owner.scout_model')?.value).toBe('');
});

const limitRow = (state: { rows: ConfigRow[] }) => state.rows.find(row => row.key === 'actual-owner.keepalive_limit')!;

test('the Prompt cache entry saves a keepalive limit, priced by default, infinite or a number', async ($, on) => {
  const state = world(on);
  await open($);
  await $.ui.select({ plugin: 'agent-router', key: 'role', requestId: 'agent-models', value: 'cache_ttl' });
  const drawn = await $.ui.render(pane);
  expect(selectOptions(drawn, 'keepalive-limit')?.map(option => option.label)).toEqual(['Default (priced)', 'Infinite', '1', '2', '3', '4', '6', '8', '12', '16', '24']);
  expect(text(drawn).includes('Each keepalive keeps an idle cache about 4½ minutes longer on a 5m TTL')).toBe(true);
  await $.ui.select({ plugin: 'agent-router', key: 'keepalive-limit', requestId: 'agent-models', value: '3' });
  expect(limitRow(state).value).toBe('3');
  expect(text(await $.ui.render(pane)).includes('Saved the keepalive limit.')).toBe(true);
  await $.ui.select({ plugin: 'agent-router', key: 'keepalive-limit', requestId: 'agent-models', value: 'infinite' });
  expect(limitRow(state).value).toBe('infinite');
});

test('any whole number can be typed as the keepalive limit, and anything else is refused', async ($, on) => {
  const state = world(on);
  await open($);
  await $.ui.select({ plugin: 'agent-router', key: 'role', requestId: 'agent-models', value: 'cache_ttl' });
  await $.ui.render(pane);
  await $.ui.input({ plugin: 'agent-router', key: 'keepalive-custom', requestId: 'agent-models', text: ' 37 ' });
  expect(limitRow(state).value).toBe('37');
  const drawn = await $.ui.render(pane);
  expect(selectOptions(drawn, 'keepalive-limit')?.at(-1)).toEqual({ value: '37', label: '37' });
  const writes = state.writes;
  for (const bad of ['0', '-2', '1.5', 'lots']) {
    await $.ui.input({ plugin: 'agent-router', key: 'keepalive-custom', requestId: 'agent-models', text: bad });
    await $.ui.render(pane);
  }
  expect(state.writes).toBe(writes);
  expect(limitRow(state).value).toBe('37');
  expect(text(await $.ui.render(pane)).includes('Enter default, infinite, or a whole number')).toBe(true);
});

test('a locked keepalive limit is shown but never written', async ($, on) => {
  const state = world(on);
  Object.assign(state.rows.find(row => row.key === 'actual-owner.keepalive_limit')!, { isLocked: true, value: '3' });
  await open($);
  await $.ui.select({ plugin: 'agent-router', key: 'role', requestId: 'agent-models', value: 'cache_ttl' });
  const drawn = await $.ui.render(pane);
  expect(selectOptions(drawn, 'keepalive-limit')).toBe(undefined);
  expect(text(drawn).includes('Keepalive limit: 3 · managed by your administrator')).toBe(true);
  expect(state.writes).toBe(0);
});

test('the Teammates entry saves the TTL teammates start in', async ($, on) => {
  const state = world(on);
  await open($);
  await $.ui.select({ plugin: 'agent-router', key: 'role', requestId: 'agent-models', value: 'teammate_model' });
  const drawn = await $.ui.render(pane);
  expect(selectOptions(drawn, 'teammate-ttl')?.map(option => option.label)).toEqual(['Default (5m)', '5m', '1h']);
  await $.ui.select({ plugin: 'agent-router', key: 'teammate-ttl', requestId: 'agent-models', value: '1h' });
  expect(state.rows.find(row => row.key === 'actual-owner.teammate_cache_ttl')?.value).toBe('1h');
});
