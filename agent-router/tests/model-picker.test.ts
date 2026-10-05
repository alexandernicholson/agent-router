import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { ConfigRow, On, RenderInput, RenderNode } from 'claude-code';

tier('user');

const pane: RenderInput<'Pane', 'terminal'> = {
  component: 'Pane', surface: 'terminal', requestId: 'agent-models',
  props: { title: 'Models', isFocused: true, bodyColumns: 76, placement: 'inline', scroll: { offset: 0, bodyRows: 24 }, view: {} },
};

type Hook = (e: { key?: string; value?: unknown }) => any;
type Model = { id: string; name: string; description: string; contextWindow?: number; outputLimit?: number };

function world(on: On, models: Model[] = [{ id: 'vendor/selected', name: 'Selected model', description: 'Catalog choice' }], env: Record<string, string> = {}) {
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
  // Similarly named foreign rows must never receive the selection.
  rows.push({ ...rows[rows.length - 5], key: 'foreign.scout_effort', provider: { plugin: 'foreign', tier: 'user' } });
  rows.unshift({ ...rows[0], key: 'foreign.scout_model', provider: { plugin: 'foreign', tier: 'user' } });
  const state = { rows, writes: 0, deny: '', opened: 0, catalogError: '', openArgs: undefined as Record<string, unknown> | undefined, squeezed: '', logs: [] as string[],
    store: new Map<string, unknown>(), hooks: {} as Partial<Record<'list' | 'set' | 'catalog' | 'store' | 'open' | 'close', Hook>> };
  mock.env(on, env);
  on('store.get', async ($, e) => (await state.hooks.store?.(e)) ?? { value: state.store.get(e.key) });
  on('store.set', async ($, e) => (await state.hooks.store?.(e)) ?? (state.store.set(e.key, e.value), { value: undefined }));
  on('store.delete', async ($, e) => (await state.hooks.store?.(e)) ?? (state.store.delete(e.key), { value: undefined }));
  on('session.id', () => ({ value: 'picker-session' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.open', async ($, e) => {
    const hooked = await state.hooks.open?.({});
    if (hooked) return hooked;
    state.opened++; state.openArgs = { ...e };
    return { value: state.squeezed ? { isPlaced: false, reason: state.squeezed } : { isPlaced: true } };
  });
  on('ui.close', async () => (await state.hooks.close?.({})) ?? { value: undefined });
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', ($, e) => { state.logs.push(e.text); return { value: undefined }; });
  on('ui.render', { component: 'Pane' }, ($, e) => $.ui.resolve(e).Text({ children: ['Another pane'] }));
  on('config.list', async () => (await state.hooks.list?.({})) ?? { value: state.rows });
  on('config.set', async ($, e) => {
    state.writes++;
    const hooked = await state.hooks.set?.(e);
    if (hooked) return hooked;
    if (state.deny) return { deny: state.deny };
    const row = state.rows.find(item => item.key === e.key)!;
    row.value = e.value;
    return { value: row.value };
  });
  on('process.run', async ($, e) => {
    const request = JSON.parse(e.init?.stdin || '{}');
    if (request.action === 'catalog') {
      const hooked = await state.hooks.catalog?.({});
      if (hooked) return hooked;
    }
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
  const roles = state.rows.filter(row => row.kind === 'text' && row.key.startsWith('actual-owner.') && row.key !== 'actual-owner.teammate_model');
  expect(roles.every(row => row.value === 'vendor/selected')).toBe(true);
  expect(state.rows.find(row => row.key === 'actual-owner.teammate_model')?.value).toBe('');
});


const press = ($: Engine, key: string) => $.ui.press({ plugin: 'agent-router', key, requestId: 'agent-models' });
const choose = ($: Engine, key: string, value: string) => $.ui.select({ plugin: 'agent-router', key, requestId: 'agent-models', value });
function labelled(node: RenderNode): string {
  if (typeof node === 'string') return node;
  const label = 'props' in node ? (node.props as { label?: string }).label ?? '' : '';
  return [label, ...('children' in node && Array.isArray(node.children) ? node.children.map(labelled) : [])].join(' ');
}
const drawn = async ($: Engine, surface: 'terminal' | 'desktop' | 'mobile' = 'terminal') => labelled(await $.ui.render({ ...pane, surface } as RenderInput<'Pane', 'terminal'>));
const command = (columns = 120) => ({ command: 'agent-models', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns } });
const row = (state: ReturnType<typeof world>, key: string) => state.rows.find(item => item.key === `actual-owner.${key}`)!;

test('the picker explains where it cannot open and why an open failed', { options: { scout_model: '' } }, async ($, on) => {
  const state = world(on, undefined, { ANTHROPIC_BASE_URL: 'https://gateway.example' });
  state.hooks.open = () => ({ deny: 'No room for the picker' });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(state.logs.some(log => log.includes('Choose your five role models'))).toBe(true);
  expect(state.logs.some(log => log.includes('No room for the picker'))).toBe(true);
  expect((await $.command.run(command(100))).text?.includes('at least 110 columns')).toBe(true);
  expect((await $.command.run(command())).text?.includes('No room for the picker')).toBe(true);
  state.store.set('agent-models:picker-session', { session: 'picker-session', open: true, role: 'reviewer_model' });
  const logged = state.logs.length;
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(state.logs.slice(logged).some(log => log.includes('No room for the picker'))).toBe(true);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false });
  expect((await $.command.run(command())).text?.includes('interactive')).toBe(true);
});

test('the desktop app opens the picker and phones are pointed to it', async ($, on) => {
  const state = world(on);
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true });
  expect(state.opened).toBe(0);
  await $.command.run(command(40));
  expect(state.opened).toBe(1);
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true });
  expect(state.opened).toBe(2);
  expect((await drawn($, 'desktop')).includes('Selected model')).toBe(true);
  expect((await drawn($, 'mobile')).includes('in the terminal or desktop')).toBe(true);
  await $.ui.press({ plugin: 'agent-router', key: 'close', requestId: 'agent-models', surface: 'mobile' });
  expect(state.store.size).toBe(0);
  expect(text(await $.ui.render({ ...pane, requestId: 'elsewhere' }))).toBe('Another pane');
});

test('catalog and settings failures each say what to check', async ($, on) => {
  const state = world(on);
  let reply: unknown;
  state.hooks.catalog = () => reply;
  reply = { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 1, stderr: ' ', stdout: '' } };
  await open($);
  expect((await drawn($)).includes('Check your configured endpoint')).toBe(true);
  reply = { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: '{}' } };
  await press($, 'refresh');
  expect((await drawn($)).includes('Refresh the catalog after checking')).toBe(true);
  reply = { deny: 'Bridge unavailable' };
  state.hooks.list = () => ({ deny: 'Settings locked away' });
  await press($, 'refresh');
  const failed = await drawn($);
  expect(failed.includes('Bridge unavailable')).toBe(true);
  expect(failed.includes('Settings unavailable')).toBe(true);
  expect(failed.includes('Saved: unavailable')).toBe(true);
  reply = { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: '{"models":[]}' } };
  state.hooks.list = undefined;
  await press($, 'refresh');
  expect((await drawn($)).includes('publishes models')).toBe(true);
});

test('searching narrows the catalog and model limits are shown', async ($, on) => {
  world(on, [{ id: 'vendor/long', name: 'Long', description: '', contextWindow: 200000 },
    { id: 'vendor/wordy', name: 'Wordy', description: '', outputLimit: 8000 }]);
  await open($);
  const listed = await drawn($);
  expect(listed.includes('Context 200000')).toBe(true);
  expect(listed.includes('Output 8000')).toBe(true);
  await $.ui.input({ plugin: 'agent-router', key: 'search', requestId: 'agent-models', text: 'nothing like it' });
  expect((await drawn($)).includes('Try another search')).toBe(true);
});

test('missing, misplaced and locked settings are explained instead of written', async ($, on) => {
  const state = world(on);
  row(state, 'scout_model').kind = 'choice';
  state.rows.splice(state.rows.indexOf(row(state, 'reviewer_effort')), 1);
  row(state, 'security_reviewer_model').isLocked = true;
  await open($);
  expect((await drawn($)).includes('requires its native control')).toBe(true);
  await choose($, 'role', 'reviewer_model');
  expect((await drawn($)).includes('has one visible Agent Router setting')).toBe(true);
  await press($, 'model:vendor/selected');
  expect(row(state, 'reviewer_model').value).toBe('vendor/selected');
  await choose($, 'role', 'security_reviewer_model');
  expect((await drawn($)).includes('Your administrator manages this setting')).toBe(true);
  await choose($, 'role', 'not_a_role');
  expect((await drawn($)).includes('Your administrator manages this setting')).toBe(true);
});

test('a model selection that the config writer changes is reported', async ($, on) => {
  const state = world(on);
  state.hooks.set = () => ({ value: 'vendor/other' });
  await open($);
  await press($, 'model:vendor/selected');
  expect((await drawn($)).includes('returned a different value')).toBe(true);
});

test('closing the picker mid-save writes nothing and leaves no reopen behind', async ($, on) => {
  const state = world(on);
  await open($);
  let step = '';
  state.hooks.list = async () => { if (step === 'list') { step = ''; await press($, 'close'); } };
  step = 'list';
  await press($, 'model:vendor/selected');
  expect(state.writes).toBe(0);
  await open($);
  state.hooks.store = async e => { if (step === 'intent' && e.value) { step = ''; await press($, 'close'); } };
  step = 'intent';
  await press($, 'model:vendor/selected');
  expect(state.writes).toBe(0);
  expect(state.store.size).toBe(0);
  await open($);
  state.hooks.set = async () => { await press($, 'close'); return { deny: 'Refused' }; };
  await press($, 'model:vendor/selected');
  expect(state.store.size).toBe(0);
});

test('controls wait while a selection is saving', async ($, on) => {
  const state = world(on, Array.from({ length: 4 }, (_, index) => ({ id: `vendor/page-${index + 1}`, name: `Choice ${index + 1}`, description: '' })));
  await open($);
  let during = '';
  state.hooks.set = async () => {
    state.hooks.set = undefined;
    await $.ui.input({ plugin: 'agent-router', key: 'search', requestId: 'agent-models', text: 'Choice 4' });
    await press($, 'next');
    await choose($, 'role', 'reviewer_model');
    await $.command.run(command());
    during = await drawn($);
  };
  await press($, 'model:vendor/page-1');
  expect(during.includes('Saving model selection')).toBe(true);
  expect(during.includes('Effort: Default')).toBe(true);
  const after = await drawn($);
  expect(after.includes('Choice 1')).toBe(true);
  expect(row(state, 'scout_model').value).toBe('vendor/page-1');
});

test('a stale model, effort or default button does nothing after the role changes', async ($, on) => {
  const state = world(on);
  for (const item of state.rows) if (item.kind === 'text' && item.key.startsWith('actual-owner.')) item.value = 'vendor/selected';
  await open($);
  await choose($, 'role', 'teammate_model');
  await drawn($);
  await choose($, 'role', 'reviewer_model');
  await press($, 'teammate-default');
  await press($, 'model:vendor/selected');
  await choose($, 'effort', 'high');
  expect(state.writes).toBe(0);
});

test('the picker shows the catalog loading', async ($, on) => {
  const state = world(on);
  let during = '';
  state.hooks.catalog = async () => { state.hooks.catalog = undefined; during = await drawn($); };
  await open($);
  expect(during.includes('Loading endpoint catalog')).toBe(true);
});

test('closing during a catalog load drops its result', async ($, on) => {
  const state = world(on);
  state.hooks.catalog = async () => { state.hooks.catalog = undefined; await drawn($); await press($, 'close'); };
  await open($);
  expect(state.store.size).toBe(0);
});

test('a close the surface refuses is reported in the picker', async ($, on) => {
  const state = world(on);
  await open($);
  state.hooks.close = () => ({ deny: 'Pane pinned open' });
  await press($, 'close');
  expect((await drawn($)).includes('Pane pinned open')).toBe(true);
});

test('restoring role defaults reports locks, refusals and a closed picker', async ($, on) => {
  const state = world(on);
  row(state, 'teammate_model').value = 'vendor/selected';
  await open($);
  await choose($, 'role', 'teammate_model');
  await drawn($);
  row(state, 'teammate_model').isLocked = true;
  await press($, 'teammate-default');
  expect((await drawn($)).includes('Your administrator manages this setting')).toBe(true);
  row(state, 'teammate_model').isLocked = false;
  await press($, 'refresh');
  await drawn($);
  state.deny = 'Managed write refused';
  await press($, 'teammate-default');
  expect((await drawn($)).includes('Managed write refused')).toBe(true);
  await drawn($);
  state.hooks.list = async () => { state.hooks.list = undefined; await press($, 'close'); };
  await press($, 'teammate-default');
  expect(row(state, 'teammate_model').value).toBe('vendor/selected');
});

test('effort selections report locks, refusals, rewrites and a closed picker', async ($, on) => {
  const state = world(on);
  await open($);
  await drawn($);
  row(state, 'scout_effort').isLocked = true;
  await choose($, 'effort', 'high');
  expect((await drawn($)).includes('update its effort')).toBe(true);
  row(state, 'scout_effort').isLocked = false;
  await press($, 'refresh');
  await drawn($);
  row(state, 'scout_effort').options = ['default', 'low'];
  await choose($, 'effort', 'high');
  expect(state.writes).toBe(0);
  row(state, 'scout_effort').options = ['default', 'high'];
  await press($, 'refresh');
  await drawn($);
  state.deny = 'Managed write refused';
  await choose($, 'effort', 'high');
  expect((await drawn($)).includes('Managed write refused')).toBe(true);
  state.deny = '';
  await drawn($);
  state.hooks.set = () => ({ value: 'low' });
  await choose($, 'effort', 'high');
  expect((await drawn($)).includes('returned a different value')).toBe(true);
  state.hooks.set = undefined;
  await drawn($);
  state.hooks.list = async () => { state.hooks.list = undefined; await press($, 'close'); };
  await choose($, 'effort', 'high');
  expect(row(state, 'scout_effort').value).toBe('default');
});

const closer = { name: 'closer', register(on: On) {
  on('command.run', { command: 'close-models' }, async $ => { await $.ui.close({ id: 'agent-models' }); return { text: 'closed' }; });
} };

test('closing the picker from elsewhere forgets it, even before setup', { plugins: [closer] }, async ($, on) => {
  const state = world(on);
  const close = { ...command(), command: 'close-models' };
  expect((await $.command.run(command())).text?.includes('after session setup')).toBe(true);
  await $.command.run(close);
  await open($);
  await $.command.run(close);
  expect(state.store.size).toBe(0);
});
