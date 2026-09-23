import type { AgentInfo, On, PluginOptions, Timer } from 'claude-code';
import { routeAgent, routeTeammate, validatePolicy, sameModel, isTruthy } from '../lib/routing.js';
import { createModelPicker, type ModelPickerHost } from './model-picker';
import { createStatsPanel } from './stats-panel';
import { agentBadge, sameSent, type Sent } from './agent-badge';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type Policy = { version: number; roles: Record<string, { model: string; aliases: string[]; effort?: Effort }>; teammate?: { model?: string; effort?: Effort } };
type Assignment = { model: string; effort?: Effort };
type Route = Assignment & { role: string; type: string };
type Snapshot = { active: true; policy: Policy; pendingConfiguration?: boolean; self?: Route; leadSessionId?: string; teammate?: { agentId: string; name?: string | null } } | { active: false; policy: null };
type AgentCall = { name?: string; subagent_type?: string; model?: string; isolation?: string; cwd?: string; tool_use_id: string };
type TeammateResult = { status?: string; agent_id?: string; name?: string; model?: string; tmux_pane_id?: string; is_splitpane?: boolean };

function pinned(e: { model: string; effort?: Effort | number }, assignment: Assignment) {
  // An absent effort means the model takes none, so none is forced on it.
  return assignment.effort !== undefined && e.effort !== undefined
    ? { model: assignment.model, effort: assignment.effort } : { model: assignment.model };
}
type Bridge = (request: Record<string, unknown>) => Promise<any>;

export function register(on: On, options: PluginOptions = {}) {
  const picker = createModelPicker(options);
  const statsPanel = createStatsPanel();
  let activityTimer: Timer | undefined;
  let activityTicks = 0;
  // Split-pane teammates record their turns from their own processes, which
  // nothing in the lead signals, so the lead polls its stats while one exists.
  const paneTeammates = new Set<string>();
  let pickerHost: ModelPickerHost | undefined;
  let snapshot: Snapshot | undefined;
  let ready: Promise<void> | undefined;
  let bridge: Bridge | undefined;
  let failure = 'Agent Router Mod has not initialized.';
  let interactive = false;
  const agents = new Map<string, Assignment>();
  // In-process teammates step under a roster id the launch result never names;
  // the roster's `name` joins them to the assignment recorded at launch.
  const teammates = new Map<string, Assignment>();
  const launching = new Set<Promise<unknown>>();
  let launchQueue: Promise<unknown> = Promise.resolve();
  const toolUsesSpawned = new Set<string>();
  // What each loop's latest model request carried, for the band's agent line.
  // The main loop is keyed '' (in a pane teammate session, that is the teammate).
  const sent = new Map<string, Sent>();

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
    const call = e as unknown as AgentCall;
    const teamsEnabled = isTruthy(await $.env.get('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'));
    // Only a named, unisolated call from the lead's main loop can become a teammate.
    if (!teamsEnabled || !interactive || !call.name || e.agentId || snapshot.leadSessionId ||
        call.isolation || call.cwd || call.subagent_type === 'fork') return next(e);
    let route: Route;
    try {
      route = routeTeammate(snapshot.policy, { subagentType: call.subagent_type });
      await bridge({ action: 'route', kind: 'teammate', name: call.name, tool_use_id: call.tool_use_id,
        requestedType: call.subagent_type ?? null, requestedModel: call.model, effectiveType: route.type });
    } catch (error) {
      return { deny: error instanceof Error ? error.message : 'Agent Router could not route this teammate.' };
    }
    const assignment = { model: route.model, effort: route.effort };
    const { model: _alias, ...rest } = e as Record<string, unknown>;
    const rewritten = { ...rest, subagent_type: route.type } as typeof e;
    // Claude Code resolves a teammate's model from this variable when the call
    // names none (the Agent tool takes aliases only). It is process-wide, so
    // launches take turns holding it and restore what was there.
    const launch = launchQueue.then(async () => {
      const previous = await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL');
      teammates.set(call.name!, assignment);
      await $.env.set('CLAUDE_CODE_SUBAGENT_MODEL', route.model);
      try { return await next(rewritten); }
      finally { await $.env.set('CLAUDE_CODE_SUBAGENT_MODEL', previous); }
    });
    launchQueue = launch.catch(() => undefined);
    launching.add(launch);
    let result;
    try { result = await launch; }
    finally { launching.delete(launch); }
    const spawned = (result as { result?: TeammateResult }).result;
    if (spawned?.status === 'teammate_spawned') {
      if (spawned.name && spawned.name !== call.name) {
        teammates.delete(call.name);
        teammates.set(spawned.name, assignment);
      }
      const backend = spawned.is_splitpane || (spawned.tmux_pane_id && spawned.tmux_pane_id !== 'in-process') ? 'tmux' : 'in-process';
      if (backend === 'tmux') paneTeammates.add(spawned.agent_id ?? call.name);
      try {
        await bridge({ action: 'result', tool_use_id: call.tool_use_id, result: { agentId: spawned.agent_id, model: spawned.model, backend } });
      } catch {
        $.ui.log('Agent Router: teammate started, but its resolution record could not be saved.', { to: 'debug' });
      }
      if (spawned.model && !sameModel(spawned.model, route.model)) {
        $.ui.log(`Agent Router mismatch: teammate ${spawned.name ?? call.name} selected ${route.model}, Claude resolved ${spawned.model}. Check /agent-router:routes.`);
      }
      await statsPanel.refreshStats();
    } else {
      teammates.delete(call.name);
      // A call the Agent tool ran as a subagent was recorded by agent.spawn.
      if (!toolUsesSpawned.has(call.tool_use_id) && ('deny' in result || 'isError' in result)) {
        await bridge({ action: 'result', tool_use_id: call.tool_use_id,
          result: { deny: ('deny' in result && result.deny) || ('text' in result && result.text) || 'The teammate did not start.' } }).catch(() => undefined);
      }
    }
    return result;
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'Agent Router guard failed before tool dispatch.' });

  on('session.start', async ($, e, next) => {
    activityTimer?.cancel();
    interactive = e.isInteractive;
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
      teammates.clear();
      paneTeammates.clear();
      for (const saved of loaded.agents || []) {
        if (!loaded.active || typeof saved.agentId !== 'string') continue;
        if (saved.kind === 'teammate') {
          if (typeof saved.name === 'string' && typeof saved.effectiveModel === 'string') {
            teammates.set(saved.name, { model: saved.effectiveModel, effort: saved.effectiveEffort });
          }
          if (saved.backend === 'tmux') paneTeammates.add(saved.agentId);
          continue;
        }
        const role = loaded.policy.roles[saved.role];
        if (role && role.model === saved.effectiveModel) {
          agents.set(saved.agentId, { model: role.model, effort: role.effort });
        }
      }
      if (typeof loaded.teammateNotice === 'string') $.ui.log(loaded.teammateNotice, { to: 'debug' });
      failure = '';
      $.ui.status(undefined);
    })().catch(error => {
      failure = error instanceof Error ? error.message : 'Agent Router initialization failed.';
      $.ui.status('Routing setup needs attention · /agent-models');
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
    await $.command.register({ name: 'agent-models-apply', immediate: true,
      description: 'Apply saved Agent Router role models and efforts to this session now.' });
    try { await picker.initialize(pickerHost, e); }
    catch (error) { $.ui.log(`Agent Router models: ${error instanceof Error ? error.message : 'Open /agent-models to retry.'}`); }
    if (!failure && snapshot?.active && e.isInteractive && e.surface === 'terminal') {
      await statsPanel.initialize({
        stats: () => bridge!({ action: 'stats' }),
        agents: () => $.agent.list(),
        managed: agent => agents.has(agent.id) || (agent.type === 'teammate' && !!agent.name && teammates.has(agent.name)),
        store: pickerHost.store,
        redraw: () => $.ui.invalidate('ui.render'),
      }, await $.session.id());
      activityTicks = 0;
      activityTimer = $.clock.every(1000, () => {
        statsPanel.refreshActivity().catch(() => $.ui.log('Agent Router: activity statistics are unavailable.', { to: 'debug' }));
        // Every fifth second: each refresh runs the bridge as a process.
        if (paneTeammates.size && ++activityTicks % 5 === 0) {
          statsPanel.refreshStats().catch(() => $.ui.log('Agent Router: usage statistics are unavailable.', { to: 'debug' }));
        }
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
    toolUsesSpawned.add(e.tool_use_id);
    await statsPanel.refreshStats();
    const result = await next({ ...e, subagentType: selected.type, model: selected.model });
    if (result.agentId) agents.set(result.agentId, { model: selected.model, effort: selected.effort });
    try {
      const recorded = await bridge({ action: 'result', tool_use_id: e.tool_use_id,
        result: { agentId: result.agentId, model: result.model, deny: result.deny } });
      if (typeof recorded.systemMessage === 'string') $.ui.log(recorded.systemMessage);
    } catch {
      $.ui.log('Agent Router: agent started, but its resolution record could not be saved.', { to: 'debug' });
    }
    await statsPanel.refreshStats();
    await statsPanel.refreshActivity();
    return result;
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'Agent Router failed before dispatch; no unconfigured model will be started.' });

  // Returns whether the band needs a redraw for this request.
  function record(loop: string, request: { model: string; effort?: Sent['effort'] }): boolean {
    const now: Sent = { model: request.model, effort: request.effort ?? null };
    if (sameSent(sent.get(loop), now)) return false;
    sent.set(loop, now);
    return true;
  }

  on('turn.step', async function* ($, e, next) {
    if (!snapshot?.active) return yield* next(e);
    // A split-pane teammate is its own session: its main loop is the teammate.
    if (!e.agentId) {
      if (!snapshot.self) return yield* next(e);
      const request = { ...e, ...pinned(e, snapshot.self) };
      if (record('', request)) $.ui.invalidate('ui.render');
      return yield* next(request);
    }
    let assignment = agents.get(e.agentId);
    if (!assignment) {
      const lookup = async () => (await $.agent.list()).find(item => item.id === e.agentId);
      let agent = await lookup();
      if (agent?.type === 'teammate' && agent.name && !teammates.has(agent.name) && launching.size) {
        // The teammate's first request can overtake its own launch result.
        await Promise.allSettled([...launching]);
        agent = await lookup();
      }
      if (agent?.type === 'teammate') {
        assignment = agent.name ? teammates.get(agent.name) : undefined;
      } else if (agent) {
        try {
          const selected = routeAgent(snapshot.policy, { subagentType: agent.type });
          assignment = { model: selected.model, effort: selected.effort };
        } catch { /* Other engine loops are not managed roles. */ }
      }
      if (assignment) agents.set(e.agentId, assignment);
    }
    if (!assignment) {
      if (record(e.agentId, e)) $.ui.invalidate('ui.render');
      return yield* next(e);
    }
    if (!sameModel(assignment.model, e.model)) $.ui.log(`Agent Router corrected a subagent model substitution to ${assignment.model}.`);
    const request = { ...e, ...pinned(e, assignment) };
    if (record(e.agentId, request)) $.ui.invalidate('ui.render');
    return yield* next(request);
  });

  on('turn.complete', async ($, e, next) => {
    // A split-pane teammate's main loop is the teammate; its lead counts it.
    const observed = e.agentId ?? (snapshot?.active && snapshot.self ? snapshot.teammate?.agentId : undefined);
    const managed = e.agentId ? agents.has(e.agentId) : observed !== undefined;
    if (snapshot?.active && bridge && observed && managed) {
      try {
        await bridge({ action: 'observe', agent_id: observed, turn_id: e.turnId, reason: e.reason, usage: e.usage });
        await statsPanel.refreshStats();
      } catch {
        $.ui.log('Agent Router: completed-turn observations could not be saved.', { to: 'debug' });
      }
    }
    return next(e);
  });

  function viewedBadge(agentId: string | undefined, agent: AgentInfo | undefined): string | undefined {
    if (!snapshot?.active) return undefined;
    if (!agentId) return snapshot.self ? agentBadge(snapshot.self, sent.get('')) : undefined;
    let assigned = agents.get(agentId);
    if (!assigned && agent?.type === 'teammate' && agent.name) assigned = teammates.get(agent.name);
    return agentBadge(assigned, sent.get(agentId));
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (failure || !snapshot?.active || e.props.hasSurvey) return next(e);
    const content = await next(e);
    const viewed = e.props.view.agentId;
    // Only an in-process teammate not yet stepped needs the roster to find it.
    const agent = viewed && !agents.has(viewed) && !sent.has(viewed) ? (await $.agent.list()).find(item => item.id === viewed) : undefined;
    return statsPanel.render($.ui.resolve(e), content, snapshot.pendingConfiguration === true, viewedBadge(viewed, agent));
  });

  on('session.end', ($, e, next) => {
    activityTimer?.cancel();
    activityTimer = undefined;
    return next(e);
  });

  on('command.run', { command: 'agent-models-apply' }, async $ => {
    await ready;
    if (!snapshot || !bridge) return { text: `Agent Router could not apply settings: ${failure || 'session setup has not completed.'}` };
    if (!snapshot.active) return { text: 'Configure an Anthropic-compatible endpoint before applying Agent Router settings.' };
    if (!snapshot.pendingConfiguration) return { text: 'This session already uses the saved Agent Router settings.' };
    try {
      const applied = await bridge({ action: 'apply' });
      validatePolicy(applied.policy);
      snapshot = { active: true, policy: applied.policy, pendingConfiguration: false };
    } catch (error) {
      return { text: `Agent Router kept this session's routing. ${error instanceof Error ? error.message : 'The saved settings could not be applied.'}` };
    }
    $.ui.invalidate('ui.render');
    const roles = Object.entries(snapshot.policy.roles)
      .map(([role, entry]) => `- ${role}: ${entry.model}${entry.effort ? ` (${entry.effort} effort)` : ''}`);
    const mate = snapshot.policy.teammate;
    const teammateLine = mate
      ? `- teammates: ${mate.model ?? 'each role\'s model'}${mate.effort ? ` (${mate.effort} effort)` : ''}`
      : '- teammates: each role\'s model and effort';
    return { text: ['Agent Router applied the saved settings. New subagents and teammates use:', ...roles, teammateLine,
      'Subagents and teammates already running keep the model and effort they started with.'].join('\n') };
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
