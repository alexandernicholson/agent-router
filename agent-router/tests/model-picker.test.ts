import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { ConfigRow, On, RenderInput } from 'claude-code';

tier('user');

const pane: RenderInput<'Pane', 'terminal'> = {
  component: 'Pane', surface: 'terminal', requestId: 'agent-models',
  props: { title: 'Models', isFocused: true, bodyColumns: 76, placement: 'inline', scroll: { offset: 0, bodyRows: 24 }, view: {} },
};

function world(on: On, models = [{ id: 'vendor/selected', name: 'Selected model', description: 'Catalog choice' }]) {
  const fields = ['scout_model', 'reviewer_model', 'security_reviewer_model', 'task_model', 'sonic_model'];
  const rows: ConfigRow[] = fields.map(field => ({ key: `actual-owner.${field}`, label: field,
    kind: 'text', value: '', provider: { plugin: 'agent-router@agent-router-tools', tier: 'user' }, isLocked: false }));
  // A similarly named foreign row must never receive the selection.
  rows.unshift({ ...rows[0], key: 'foreign.scout_model', provider: { plugin: 'foreign', tier: 'user' } });
  const state = { rows, writes: 0, deny: '', opened: 0 };
  mock.store(on);
  mock.env(on, {});
  on('session.id', () => ({ value: 'picker-session' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.open', () => { state.opened++; return { value: undefined }; });
  on('ui.close', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', () => ({ value: undefined }));
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
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify(request.action === 'catalog'
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
