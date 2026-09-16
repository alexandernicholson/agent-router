import { test, expect, mock, tier } from 'claude-code/testing';
import type { AgentInfo, RenderInput, RenderNode } from 'claude-code';
import { ROLES } from '../lib/routing.js';

tier('user');

const band: RenderInput<'AbovePrompt', 'terminal'> = {
  component: 'AbovePrompt', surface: 'terminal', requestId: 'stats-band',
  props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 5 }, view: {} },
};

function text(node: RenderNode): string {
  if (typeof node === 'string') return node;
  return 'children' in node && Array.isArray(node.children) ? node.children.map(text).join(' ') : '';
}

test('resumed agents lose their previous terminal status across roster removal and reload', async ($, on) => {
  const clock = mock.clock(on);
  mock.store(on);
  mock.env(on, {});
  const managed: AgentInfo = { id: 'managed', description: 'Worker', type: 'task', status: 'completed' };
  const foreign: AgentInfo = { id: 'foreign', description: 'Unmanaged', type: 'task', status: 'running' };
  let roster = [managed, foreign];
  const policy = { version: 1, roles: Object.fromEntries(ROLES.map(role => [role, { model: 'vendor/worker-v1', aliases: [role] }])) };
  on('session.id', () => ({ value: 'stats-session' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('agent.list', () => ({ value: roster }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }));
  on('process.run', ($, e) => {
    const request = JSON.parse(e.init?.stdin || '{}');
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify(request.action === 'bootstrap'
      ? { active: true, policy, agents: [{ agentId: 'managed', role: 'task', effectiveModel: 'vendor/worker-v1' }] }
      : { routed: 0, overrides: 0, mismatches: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) } };
  });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(text(await $.ui.render(band)).match(/\d+/g)?.map(Number)).toEqual([0, 1, 0]);
  roster = [{ ...managed, status: 'running' }, foreign];
  await clock.advance(1000);
  expect(text(await $.ui.render(band)).match(/\d+/g)?.map(Number)).toEqual([1, 0, 0]);
  roster = [foreign];
  await clock.advance(1000);
  expect(text(await $.ui.render(band)).match(/\d+/g)?.map(Number)).toEqual([0, 0, 0]);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(text(await $.ui.render(band)).match(/\d+/g)?.map(Number)).toEqual([0, 0, 0]);
});
