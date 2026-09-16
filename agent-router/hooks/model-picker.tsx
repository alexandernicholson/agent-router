import type { Args, ConfigRow, EngineInterface, PluginOptions } from 'claude-code';
import { filterModels } from '../lib/catalog.js';

export type ModelPickerHost = {
  plugin: Pick<EngineInterface['plugin'], 'name' | 'root'>;
  ui: Pick<EngineInterface['ui'], 'invalidate' | 'open' | 'close' | 'log' | 'resolve'>;
  store: Pick<EngineInterface['store'], 'get' | 'set' | 'delete'>;
  config: Pick<EngineInterface['config'], 'list' | 'set'>;
  process: Pick<EngineInterface['process'], 'run'>;
  command: Pick<EngineInterface['command'], 'register'>;
  session: Pick<EngineInterface['session'], 'id'>;
  endpoint: () => Promise<string | undefined>;
};

type ModelEntry = { id: string; name: string; description: string; contextWindow?: number; outputLimit?: number };
const paneId = 'agent-models';
const roles = [
  { value: 'scout_model', label: 'Scout' },
  { value: 'reviewer_model', label: 'Reviewer' },
  { value: 'security_reviewer_model', label: 'Security reviewer' },
  { value: 'task_model', label: 'Task' },
  { value: 'sonic_model', label: 'Sonic' },
];
const pageSize = 3;
const message = (error: unknown) => error instanceof Error ? error.message : 'Open /agent-models again to retry.';

// Ownership comes from the actual config rows, never from a constructed write key.
function roleRow(rows: ConfigRow[], plugin: string, field: string): ConfigRow {
  const matches = rows.filter(row => (row.provider.plugin === plugin || row.provider.plugin.startsWith(`${plugin}@`)) && row.key.endsWith(`.${field}`));
  if (matches.length !== 1) throw new Error(`Open /config and check that ${field} has one visible Agent Router setting.`);
  const row = matches[0];
  if (row.kind !== 'text') throw new Error(`Open /config to edit ${row.label}; this setting requires its native control.`);
  return row;
}

export function createModelPicker(options: PluginOptions) {
  let session = '';
  let interactive = false;
  let terminal = false;
  let intentKey = '';
  let open = false;
  let role = roles.find(item => !options[item.value])?.value || roles[0].value;
  let query = '';
  let page = 0;
  let models: ModelEntry[] = [];
  let rows: ConfigRow[] = [];
  let loading = false;
  let saving = false;
  let error = '';
  let notice = '';
  let generation = 0;

  const redraw = (host: ModelPickerHost) => host.ui.invalidate('ui.render');
  const intent = (host: ModelPickerHost, selected = role) => host.store.set(intentKey, { session, open: true, role: selected });
  const missing = (plugin: string, except?: string) => roles.find(item => {
    if (item.value === except) return false;
    try { return !roleRow(rows, plugin, item.value).value; } catch { return false; }
  })?.value;

  async function refresh(host: ModelPickerHost) {
    if (saving) return;
    const request = ++generation;
    loading = true;
    error = '';
    models = [];
    redraw(host);
    try {
      const [result, currentRows] = await Promise.all([
        host.process.run(['node', `${host.plugin.root}/scripts/bridge.mjs`], {
          stdin: JSON.stringify({ action: 'catalog' }), timeoutMs: 20_000,
        }),
        host.config.list(),
      ]);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Check your configured endpoint and refresh the model catalog.');
      const catalog = JSON.parse(result.stdout);
      if (request !== generation || !open) return;
      if (!Array.isArray(catalog.models)) throw new Error('Refresh the catalog after checking the configured endpoint.');
      models = catalog.models;
      rows = currentRows;
      page = 0;
    } catch (cause) {
      if (request === generation && open) error = message(cause);
    } finally {
      if (request === generation) { loading = false; redraw(host); }
    }
  }

  async function show(host: ModelPickerHost) {
    open = true;
    query = '';
    page = 0;
    error = '';
    await intent(host);
    await host.ui.open({ id: paneId, title: 'Agent Router models', focus: true, closeOnEscape: true, rows: 24 });
    await refresh(host);
  }

  async function close(host: ModelPickerHost) {
    open = false;
    ++generation;
    await host.store.delete(intentKey);
    await host.ui.close({ id: paneId });
  }

  async function save(host: ModelPickerHost, field: string, id: string, renderedGeneration: number) {
    if (!open || saving || loading || renderedGeneration !== generation || field !== role) return;
    if (!models.some(model => model.id === id)) return;
    saving = true;
    error = '';
    notice = '';
    redraw(host);
    try {
      rows = await host.config.list();
      if (!open) return;
      const row = roleRow(rows, host.plugin.name, field);
      if (row.isLocked) throw new Error('Your administrator manages this setting. Ask them to update its model.');
      const nextRole = missing(host.plugin.name, field) || field;
      // The config writer can reload this module before its promise resolves.
      await intent(host, nextRole);
      if (!open) { await host.store.delete(intentKey); return; }
      const result = await host.config.set({ key: row.key, value: id });
      if (result.deny !== undefined) throw new Error(result.deny);
      if (result.value !== id) throw new Error('The config writer returned a different value. Open /config to inspect the saved setting.');
      rows = rows.map(item => item.key === row.key ? { ...item, value: id } : item);
      role = nextRole;
      page = 0;
      notice = `Saved ${roles.find(item => item.value === field)!.label}. New sessions use the saved settings; this session keeps its routing policy.`;
    } catch (cause) {
      error = message(cause);
      if (open) await intent(host, field);
    } finally {
      saving = false;
      redraw(host);
    }
  }

  async function initialize(host: ModelPickerHost, e: Args<'session.start'>) {
    interactive = e.isInteractive && (e.surface === 'terminal' || e.surface === 'desktop');
    terminal = e.surface === 'terminal';
    await host.command.register({ name: paneId, description: 'Choose Agent Router role models from the configured endpoint.' });
    session = await host.session.id();
    intentKey = `${paneId}:${session}`;
    const saved = await host.store.get(intentKey) as { session?: string; open?: boolean; role?: string } | undefined;
    if (saved?.session === session && saved.open && roles.some(item => item.value === saved.role)) {
      role = saved.role!;
      if (e.isInteractive && (e.surface === 'terminal' || e.surface === 'desktop')) {
        try { await show(host); } catch (cause) { host.ui.log(`Agent Router models: ${message(cause)}`); }
      }
    } else if (e.isInteractive && (e.surface === 'terminal' || e.surface === 'desktop') &&
      roles.some(item => !options[item.value]) && await host.endpoint()) {
      host.ui.log('Choose your five role models with /agent-models. Each selection is saved for new sessions. Use a terminal at least 110 columns wide.');
      try { await show(host); } catch (cause) { host.ui.log(`Agent Router models: ${message(cause)}`); }
    }
  }

  const commandRun = async (host: ModelPickerHost, e: Args<'command.run'>) => {
    if (!interactive) return { text: 'Open /agent-models in an interactive Claude Code terminal or desktop session.' };
    if (terminal && e.presentation.columns < 110) {
      return { text: 'Widen the terminal to at least 110 columns, then run /agent-models.' };
    }
    try { await show(host); return {}; }
    catch (cause) { return { text: `Agent Router models: ${message(cause)}` }; }
  };

  const uiClose = async (host: ModelPickerHost, e: Args<'ui.close'>) => {
    open = false;
    ++generation;
    if (e.origin.kind !== 'unload') await host.store.delete(intentKey);
  };

  const uiRender = (host: ModelPickerHost, e: Args<'ui.render'>) => {
    if (e.requestId !== paneId) return;
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Box, Text, Button } = host.ui.resolve(e);
      return <Box flexDirection="column"><Text>Open /agent-models in the terminal or desktop to use role and search controls.</Text><Button key="close" label="Close" onPress={() => close(host)} /></Box>;
    }
    const { Box, Text, Button, Select, Input } = host.ui.resolve(e);
    let current: ConfigRow | undefined;
    let rowError = '';
    if (!loading) {
      try { current = roleRow(rows, host.plugin.name, role); } catch (cause) { rowError = message(cause); }
    }
    const filtered: ModelEntry[] = filterModels(models, query);
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pages - 1);
    const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
    const field = role;
    const renderedGeneration = generation;
    const search = (text: string) => { if (!saving) { query = text; page = 0; redraw(host); } };
    const act = (operation: () => Promise<void>) => operation().catch(cause => { error = message(cause); redraw(host); });
    const navigate = (offset: number) => {
      if (saving || loading) return;
      page = (page + offset + pages) % pages;
      redraw(host);
    };
    return <Box flexDirection="column">
      <Text>Choose a model for each role. Search by name or ID, then select an entry. Active sessions retain their current assignments.</Text>
      {notice ? <Text>{notice}</Text> : null}
      {error ? <Text>{error}</Text> : null}
      <Box flexDirection="row" gap={1}>
        {saving ? null : <Button key="refresh" label="Refresh catalog" onPress={() => act(() => refresh(host))} />}
        <Button key="close" label="Close" onPress={() => act(() => close(host))} />
      </Box>
      <Select key="role" label="Role" value={role} options={roles} onSelect={value => {
        if (saving || !roles.some(item => item.value === value)) return;
        role = value; page = 0; error = ''; notice = ''; redraw(host);
        return act(() => intent(host));
      }} />
      <Text>{`Saved: ${current?.value || 'Choose a model'}`}</Text>
      {current?.isLocked ? <Text>Your administrator manages this setting. Ask them to update its model.</Text> : null}
      {rowError ? <Text>{rowError}</Text> : null}
      <Input key="search" label="Search" placeholder="Name, exact ID, or description" value={query} autoFocus onInput={search} onSubmit={search} />
      {loading ? <Text>Loading endpoint catalog…</Text> : saving ? <Text>Saving model selection…</Text> : <Box flexDirection="column" gap={1}>
        <Text>{`${filtered.length} matching models · page ${page + 1} of ${pages}`}</Text>
        {/* Stable controls precede changing model rows to preserve terminal keyboard focus. */}
        {pages > 1 ? <Box flexDirection="row" gap={1}>
          <Button key="previous" label={page > 0 ? 'Previous' : 'Last page'} onPress={() => navigate(-1)} />
          <Button key="next" label={page + 1 < pages ? 'Next' : 'First page'} onPress={() => navigate(1)} />
        </Box> : null}
        {visible.length === 0 ? <Text>{models.length ? 'Try another search to find a model.' : 'Refresh after checking that your configured endpoint publishes models.'}</Text> : null}
        {visible.map(model => <Box key={model.id} flexDirection="column">
          {current && !current.isLocked ? <Button key={`model:${model.id}`} label={`${model.name} — ${model.id}`} onPress={() => act(() => save(host, field, model.id, renderedGeneration))} /> : <Text>{`${model.name} — ${model.id}`}</Text>}
          {model.description ? <Text dimColor>{model.description}</Text> : null}
          {model.contextWindow || model.outputLimit ? <Text dimColor>{[model.contextWindow ? `Context ${model.contextWindow}` : '', model.outputLimit ? `Output ${model.outputLimit}` : ''].filter(Boolean).join(' · ')}</Text> : null}
        </Box>)}
      </Box>}
    </Box>;
  };
  return { initialize, commandRun, uiClose, uiRender };
}
