import type { AgentInfo, Elements, EngineInterface, RenderElement, RenderSurface } from 'claude-code';

export type DashboardStats = {
  routed: number;
  overrides: number;
  mismatches: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

export type StatsPanelHost = {
  stats: () => Promise<DashboardStats>;
  agents: () => Promise<AgentInfo[]>;
  managed: (agent: AgentInfo) => boolean;
  store: Pick<EngineInterface['store'], 'get' | 'set'>;
  redraw: () => void;
};

export type StatsPanel = {
  initialize: (host: StatsPanelHost, sessionId: string) => Promise<void>;
  refreshStats: () => Promise<void>;
  refreshActivity: () => Promise<void>;
  render: (elements: Elements[RenderSurface], content: RenderElement, pending: boolean, agent?: string) => RenderElement;
};

type View = 'Activity' | 'Usage' | 'Routing';
type TerminalStatus = 'completed' | 'failed' | 'killed';
type Activity = { running: number; completed: number; failed: number };
type Context = {
  host: StatsPanelHost;
  key: string;
  terminals: Map<string, TerminalStatus>;
  historyLoaded: boolean;
  historyDirty: boolean;
  stats?: DashboardStats;
  activity?: Activity;
  statsRefresh?: Promise<void>;
  activityRefresh?: Promise<void>;
  statsAgain: boolean;
  activityAgain: boolean;
};

const views: View[] = ['Activity', 'Usage', 'Routing'];
const statFields: (keyof DashboardStats)[] = ['routed', 'overrides', 'mismatches', 'inputTokens', 'outputTokens', 'cacheReadTokens'];
const terminalStatus = (status: unknown): status is TerminalStatus => status === 'completed' || status === 'failed' || status === 'killed';

// Fixed decimal notation avoids locale-specific separators and suffixes.
function tokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  const divisor = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : 1000;
  const suffix = divisor === 1e9 ? 'b' : divisor === 1e6 ? 'm' : 'k';
  return `${Number((value / divisor).toFixed(1))}${suffix}`;
}

export function createStatsPanel(): StatsPanel {
  let context: Context | undefined;
  let view: View = 'Activity';
  let clicks = 0;
  let unpersistedClick = false;
  let preferenceError = false;
  let preferenceWrites = Promise.resolve();

  function label(): string {
    let value = 'unavailable';
    if (view === 'Activity' && context?.activity) {
      const { running, completed, failed } = context.activity;
      value = `${running} running · ${completed} completed · ${failed} failed`;
    } else if (view === 'Usage' && context?.stats) {
      const { inputTokens, outputTokens, cacheReadTokens } = context.stats;
      value = `${tokens(inputTokens)} in · ${tokens(outputTokens)} out · ${tokens(cacheReadTokens)} cache read`;
    } else if (view === 'Routing' && context?.stats) {
      const { routed, overrides, mismatches } = context.stats;
      value = `${routed} routed · ${overrides} overrides · ${mismatches} mismatches`;
    }
    return `${view.padEnd(8)}  ${value}${preferenceError ? ' · view unsaved' : ''}`;
  }

  function redraw(previous: string, current: Context): void {
    if (context !== current || previous === label()) return;
    try { current.host.redraw(); } catch { /* A closed surface must not break refreshes. */ }
  }

  function persistView(current: Context, selected: View): Promise<void> {
    preferenceWrites = preferenceWrites.then(async () => {
      try {
        await current.host.store.set('stats-view', selected);
        if (context === current) {
          const previous = label();
          preferenceError = false;
          redraw(previous, current);
        }
      } catch {
        if (context === current) {
          const previous = label();
          preferenceError = true;
          redraw(previous, current);
        }
      }
    });
    return preferenceWrites;
  }

  function cycle(): Promise<void> {
    const previous = label();
    view = views[(views.indexOf(view) + 1) % views.length];
    clicks++;
    if (!context) {
      unpersistedClick = true;
      return Promise.resolve();
    }
    redraw(previous, context);
    unpersistedClick = false;
    return persistView(context, view);
  }

  function refreshStats(): Promise<void> {
    const current = context;
    if (!current) return Promise.resolve();
    current.statsAgain = true;
    if (current.statsRefresh) return current.statsRefresh;
    current.statsRefresh = (async () => {
      while (current.statsAgain && context === current) {
        current.statsAgain = false;
        let stats: DashboardStats | undefined;
        try {
          const result = await current.host.stats();
          if (statFields.every(field => Number.isSafeInteger(result[field]) && result[field] >= 0)) stats = result;
        } catch { /* Missing data is not a zero-count observation. */ }
        const previous = label();
        current.stats = stats;
        redraw(previous, current);
      }
    })().finally(() => {
      current.statsRefresh = undefined;
      if (current.statsAgain && context === current) return refreshStats();
    });
    return current.statsRefresh;
  }

  function refreshActivity(): Promise<void> {
    const current = context;
    if (!current) return Promise.resolve();
    current.activityAgain = true;
    if (current.activityRefresh) return current.activityRefresh;
    current.activityRefresh = (async () => {
      while (current.activityAgain && context === current) {
        current.activityAgain = false;
        let activity: Activity | undefined;
        try {
          if (!current.historyLoaded) {
            const saved = await current.host.store.get(current.key);
            if (context !== current) return;
            if (saved !== undefined) {
              if (!Array.isArray(saved) || !saved.every(row => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && terminalStatus(row[1]))) throw new Error('Invalid activity history');
              for (const [id, status] of saved) current.terminals.set(id, status);
            }
            current.historyLoaded = true;
          }
          const agents = await current.host.agents();
          if (context !== current) return;
          const live = new Map(agents.filter(agent => current.host.managed(agent)).map(agent => [agent.id, agent]));
          let running = 0;
          for (const agent of live.values()) {
            if (agent.status === 'running') running++;
            if (terminalStatus(agent.status) && current.terminals.get(agent.id) !== agent.status) {
              current.terminals.set(agent.id, agent.status);
              current.historyDirty = true;
            } else if (!terminalStatus(agent.status) && current.terminals.delete(agent.id)) {
              current.historyDirty = true;
            }
          }
          if (current.historyDirty) {
            await current.host.store.set(current.key, [...current.terminals]);
            current.historyDirty = false;
          }
          let completed = 0;
          let failed = 0;
          for (const status of current.terminals.values()) {
            if (status === 'completed') completed++;
            else failed++;
          }
          activity = { running, completed, failed };
        } catch { /* Retry history reads/writes on the next native refresh. */ }
        const previous = label();
        current.activity = activity;
        redraw(previous, current);
      }
    })().finally(() => {
      current.activityRefresh = undefined;
      if (current.activityAgain && context === current) return refreshActivity();
    });
    return current.activityRefresh;
  }

  async function initialize(host: StatsPanelHost, sessionId: string): Promise<void> {
    const previous = label();
    const current: Context = { host, key: `stats-activity:${sessionId}`, terminals: new Map(), historyLoaded: false, historyDirty: false, statsAgain: false, activityAgain: false };
    context = current;
    redraw(previous, current);
    const initialClicks = clicks;
    try {
      // Finish any earlier clicks before reading their persisted choice.
      await preferenceWrites;
      const saved = await host.store.get('stats-view');
      if (context !== current) return;
      const before = label();
      if (clicks === initialClicks && clicks === 0 && views.includes(saved as View)) view = saved as View;
      preferenceError = false;
      redraw(before, current);
    } catch {
      if (context !== current) return;
      const before = label();
      preferenceError = true;
      redraw(before, current);
    }
    if (context !== current) return;
    if (unpersistedClick) {
      unpersistedClick = false;
      await persistView(current, view);
    }
    await Promise.all([refreshStats(), refreshActivity()]);
  }

  // `agent` is the viewed agent's `model · effort`, beside the icon.
  function render(elements: Elements[RenderSurface], content: RenderElement, pending: boolean, agent?: string): RenderElement {
    const { Box, Button, Text } = elements;
    const icon = pending ? '⇄*' : '⇄';
    return Box({ flexDirection: 'column', children: [content, Box({ flexDirection: 'row', gap: 1, children: [
      Button({ key: 'router-view', label: agent ? `${icon} · ${agent}` : icon, onPress: cycle }),
      Text({ dimColor: true, children: [label()] }),
    ] })] });
  }

  return { initialize, refreshStats, refreshActivity, render };
}
