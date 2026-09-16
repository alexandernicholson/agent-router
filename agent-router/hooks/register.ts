import type { On, PluginOptions, Timer } from 'claude-code';
import { routeAgent, validatePolicy, sameModel } from '../lib/routing.js';
import { createModelPicker, type ModelPickerHost } from './model-picker';
import { createStatsPanel } from './stats-panel';

type Policy = { version: number; roles: Record<string, { model: string; aliases: string[] }> };
type Snapshot = { active: true; policy: Policy; pendingConfiguration?: boolean } | { active: false; policy: null };
type Bridge = (request: Record<string, unknown>) => Promise<any>;

export function register(on: On, options: PluginOptions = {}) {
  const picker = createModelPicker(options);
  const statsPanel = createStatsPanel();
  let activityTimer: Timer | undefined;
  let pickerHost: ModelPickerHost | undefined;
  let snapshot: Snapshot | undefined;
  let ready: Promise<void> | undefined;
  let bridge: Bridge | undefined;
  let failure = 'Agent Router Mod has not initialized.';
  const agents = new Map<string, string>();

  on('tool.call', async ($, e, next) => {
    if (!/^(Agent|Task)$/.test(e.tool)) return next(e);
    await ready;
    if (!snapshot || !bridge) return { deny: failure };
    const input = e as { isolation?: string; subagent_type?: string };
    if (!snapshot.active) {
      return input.subagent_type?.startsWith('agent-router:')
        ? { deny: 'Configure an Anthropic-compatible endpoint before using an Agent Router role.' } : next(e);
    }
    if (input.isolation === 'remote') return { deny: 'Remote agents cannot inherit the local Agent Router Mod. Use a local role.' };
    return next(e);
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'Agent Router guard failed before tool dispatch.' });

  on('session.start', async ($, e, next) => {
    activityTimer?.cancel();
    ready = (async () => {
      snapshot = undefined;
      const root = $.plugin.root;
      const sessionId = await $.session.id();
      bridge = async request => {
        const result = await $.process.run(['node', `${root}/scripts/bridge.mjs`], {
          stdin: JSON.stringify({ ...request, options, session_id: sessionId }), timeoutMs: 20_000,
        });
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Agent Router bridge failed.');
        return JSON.parse(result.stdout);
      };
      const loaded = await bridge({ action: 'bootstrap' });
      if (typeof loaded.active !== 'boolean') throw new Error('Invalid Agent Router bootstrap response.');
      if (loaded.active) validatePolicy(loaded.policy);
      snapshot = loaded;
      agents.clear();
      for (const saved of loaded.agents || []) {
        if (loaded.active && typeof saved.agentId === 'string' && loaded.policy.roles[saved.role]?.model === saved.effectiveModel) {
          agents.set(saved.agentId, saved.effectiveModel);
        }
      }
      failure = '';
      $.ui.status(undefined);
    })().catch(error => {
      failure = error instanceof Error ? error.message : 'Agent Router initialization failed.';
      $.ui.status('Choose role models with /agent-models');
    });
    await ready;
    $.ui.invalidate('ui.render');
    pickerHost = {
      plugin: { name: $.plugin.name, root: $.plugin.root },
      ui: {
        invalidate: event => $.ui.invalidate(event),
        open: input => $.ui.open(input),
        close: input => $.ui.close(input),
        log: text => $.ui.log(text),
        resolve: input => $.ui.resolve(input),
      },
      store: {
        get: key => $.store.get(key),
        set: (key, value) => $.store.set(key, value),
        delete: key => $.store.delete(key),
      },
      config: { list: () => $.config.list(), set: input => $.config.set(input) },
      process: { run: (argv, settings) => $.process.run(argv, settings) },
      command: { register: input => $.command.register(input) },
      session: { id: () => $.session.id() },
      endpoint: () => $.env.get('ANTHROPIC_BASE_URL'),
    };
    try { await picker.initialize(pickerHost, e); }
    catch (error) { $.ui.log(`Agent Router models: ${error instanceof Error ? error.message : 'Open /agent-models to retry.'}`); }
    if (!failure && snapshot?.active && e.isInteractive && e.surface === 'terminal') {
      await statsPanel.initialize({
        stats: () => bridge!({ action: 'stats' }),
        agents: () => $.agent.list(),
        managed: agent => agents.has(agent.id),
        store: pickerHost.store,
        redraw: () => $.ui.invalidate('ui.render'),
      }, await $.session.id());
      activityTimer = $.clock.every(1000, () => {
        statsPanel.refreshActivity().catch(() => $.ui.log('Agent Router: activity statistics are unavailable.'));
      });
    }
    return next(e);
  });

  on('agent.spawn', async ($, e, next) => {
    await ready;
    if (!snapshot || !bridge) return { deny: failure };
    if (!snapshot.active) {
      return e.subagentType.startsWith('agent-router:')
        ? { deny: 'Configure an Anthropic-compatible endpoint before using an Agent Router role.' } : next(e);
    }
    let selected;
    try {
      selected = routeAgent(snapshot.policy, e);
      await bridge({ action: 'route', tool_use_id: e.tool_use_id, agent_id: e.parentAgentId,
        requestedType: e.subagentType, requestedModel: e.model, effectiveType: selected.type });
    } catch (error) {
      return { deny: error instanceof Error ? error.message : 'Agent Router could not resolve this role.' };
    }
    await statsPanel.refreshStats();
    const result = await next({ ...e, subagentType: selected.type, model: selected.model });
    if (result.agentId) agents.set(result.agentId, selected.model);
    try {
      const recorded = await bridge({ action: 'result', tool_use_id: e.tool_use_id,
        result: { agentId: result.agentId, model: result.model, deny: result.deny } });
      if (typeof recorded.systemMessage === 'string') $.ui.log(recorded.systemMessage);
    } catch {
      $.ui.log('Agent Router: agent started, but its resolution record could not be saved.');
    }
    await statsPanel.refreshStats();
    await statsPanel.refreshActivity();
    return result;
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'Agent Router failed before dispatch; no unconfigured model will be started.' });

  on('turn.step', async function* ($, e, next) {
    if (!snapshot?.active || !e.agentId) return yield* next(e);
    let model = agents.get(e.agentId);
    if (!model) {
      const agent = (await $.agent.list()).find(item => item.id === e.agentId);
      if (agent) {
        try { model = routeAgent(snapshot.policy, { subagentType: agent.type }).model; }
        catch { /* Other engine loops are not managed roles. */ }
      }
      if (model) agents.set(e.agentId, model);
    }
    if (model && !sameModel(model, e.model)) $.ui.log(`Agent Router corrected a subagent model substitution to ${model}.`);
    return yield* next(model ? { ...e, model } : e);
  });

  on('turn.complete', async ($, e, next) => {
    if (snapshot?.active && bridge && e.agentId && agents.has(e.agentId)) {
      try {
        await bridge({ action: 'observe', agent_id: e.agentId, turn_id: e.turnId, reason: e.reason, usage: e.usage });
        await statsPanel.refreshStats();
      } catch {
        $.ui.log('Agent Router: completed-turn observations could not be saved.');
      }
    }
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (failure || !snapshot?.active || e.props.hasSurvey) return next(e);
    const content = await next(e);
    return statsPanel.render($.ui.resolve(e), content, snapshot.pendingConfiguration === true);
  });

  on('session.detach', ($, e, next) => {
    if (e.reason === 'end') activityTimer?.cancel();
    return next(e);
  });

  on('command.run', { command: 'agent-models' }, ($, e) => pickerHost
    ? picker.commandRun(pickerHost, e) : { text: 'Run /agent-models after session setup completes.' });
  on('ui.close', { id: 'agent-models' }, async ($, e, next) => {
    if (pickerHost) await picker.uiClose(pickerHost, e);
    return next(e);
  });
  on('ui.render', { component: 'Pane' }, ($, e, next) =>
    (pickerHost && picker.uiRender(pickerHost, e)) || next(e));
}
