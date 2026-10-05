import type { Args, ConfigRow, EngineInterface, PluginOptions } from 'claude-code';
import { filterModels } from '../lib/catalog.js';
import type { TtlDefault } from '../lib/cache-ttl.js';

export type ModelPickerHost = {
  plugin: Pick<EngineInterface['plugin'], 'name' | 'root'>;
  ui: Pick<EngineInterface['ui'], 'invalidate' | 'open' | 'close' | 'log' | 'resolve'>;
  store: Pick<EngineInterface['store'], 'get' | 'set' | 'delete'>;
  config: Pick<EngineInterface['config'], 'list' | 'set'>;
  process: Pick<EngineInterface['process'], 'run'>;
  command: Pick<EngineInterface['command'], 'register'>;
  session: Pick<EngineInterface['session'], 'id'>;
  endpoint: () => Promise<string | undefined>;
  ttlDefaults: () => Promise<{ main: TtlDefault; subagent: TtlDefault }>;
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
// Optional: an unset teammate override means each teammate uses its role's.
const teammateEntry = { value: 'teammate_model', label: 'Teammates' };
const cacheEntry = { value: 'cache_ttl', label: 'Prompt cache' };
const entries = [...roles, teammateEntry, cacheEntry];
const entryLabel = (field: string) => entries.find(item => item.value === field)!.label;
const pageSize = 3;
// The picker's controls need this many columns; a fullscreen dock opens this wide.
const minimumColumns = 110;
const message = (error: unknown) => error instanceof Error ? error.message : 'Open /agent-models again to retry.';

// Ownership comes from the actual config rows, never from a constructed write key.
function ownedRow(rows: ConfigRow[], plugin: string, field: string, kind: ConfigRow['kind']): ConfigRow {
  const matches = rows.filter(row => (row.provider.plugin === plugin || row.provider.plugin.startsWith(`${plugin}@`)) && row.key.endsWith(`.${field}`));
  if (matches.length !== 1) throw new Error(`Open /config and check that ${field} has one visible Agent Router setting.`);
  const row = matches[0];
  if (row.kind !== kind) throw new Error(`Open /config to edit ${row.label}; this setting requires its native control.`);
  return row;
}
const roleRow = (rows: ConfigRow[], plugin: string, field: string) => ownedRow(rows, plugin, field, 'text');
const effortField = (field: string) => field.replace(/_model$/, '_effort');
const effortRow = (rows: ConfigRow[], plugin: string, field: string) => ownedRow(rows, plugin, effortField(field), 'choice');
const effortLabel = (value: string) => value === 'default' ? 'Default (engine effort)' : value;
const upkeepRow = (rows: ConfigRow[], plugin: string) => ownedRow(rows, plugin, 'teammate_cache_upkeep', 'choice');
const CACHE_FIELDS: Record<string, string> = { 'cache-ttl': 'cache_ttl', 'subagent-ttl': 'subagent_cache_ttl', 'teammate-ttl': 'teammate_cache_ttl', 'keepalive-limit': 'keepalive_limit' };
const cacheRow = (rows: ConfigRow[], plugin: string, key: string) => ownedRow(rows, plugin, CACHE_FIELDS[key], key === 'keepalive-limit' ? 'text' : 'choice');
const LIMITS = ['default', 'infinite', '1', '2', '3', '4', '6', '8', '12', '16', '24'];
const limitValue = (value: string) => {
  const text = value.trim().toLowerCase();
  if (text === 'default' || text === 'infinite') return text;
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? String(Number(text)) : undefined;
};
const limitLabel = (value: string) => value === 'default' ? 'Default (priced)' : value === 'infinite' ? 'Infinite' : value;

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
  let catalogLoaded = false;
  let configLoaded = false;
  let catalogError = '';
  let configError = '';
  let loading = false;
  let saving = false;
  let error = '';
  let notice = '';
  let generation = 0;
  let defaults: { main: TtlDefault; subagent: TtlDefault } | undefined;

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
    catalogError = '';
    configError = '';
    catalogLoaded = false;
    configLoaded = false;
    models = [];
    rows = [];
    redraw(host);
    try {
      const [discovery, settings, resolved] = await Promise.allSettled([
        host.process.run(['node', `${host.plugin.root}/scripts/bridge.mjs`], {
          stdin: JSON.stringify({ action: 'catalog' }), timeoutMs: 20_000,
        }),
        host.config.list(),
        host.ttlDefaults(),
      ]);
      if (request !== generation || !open) return;
      if (resolved.status === 'fulfilled') defaults = resolved.value;
      if (settings.status === 'fulfilled') {
        rows = settings.value;
        configLoaded = true;
      } else {
        configError = `Settings unavailable: ${message(settings.reason)}`;
      }
      if (discovery.status === 'rejected') throw discovery.reason;
      const result = discovery.value;
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Check your configured endpoint and refresh the model catalog.');
      const catalog = JSON.parse(result.stdout);
      if (!Array.isArray(catalog.models)) throw new Error('Refresh the catalog after checking the configured endpoint.');
      models = catalog.models;
      catalogLoaded = true;
      page = 0;
    } catch (cause) {
      if (request === generation && open) catalogError = message(cause);
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
    const opened = await host.ui.open({ id: paneId, title: 'Agent Router models', focus: true, closeOnEscape: true, rows: 24, columns: minimumColumns });
    if (!opened.isPlaced) host.ui.log(`Agent Router models: the picker is open but waits undrawn. ${opened.reason}`);
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
      notice = `Saved ${entryLabel(field)}. New sessions use the saved settings; run /agent-models-apply to use them in this session.`;
    } catch (cause) {
      error = message(cause);
      if (open) await intent(host, field);
    } finally {
      saving = false;
      redraw(host);
    }
  }

  async function clearTeammate(host: ModelPickerHost, renderedGeneration: number) {
    if (!open || saving || loading || renderedGeneration !== generation || role !== teammateEntry.value) return;
    saving = true;
    error = '';
    notice = '';
    redraw(host);
    try {
      rows = await host.config.list();
      if (!open) return;
      const row = roleRow(rows, host.plugin.name, teammateEntry.value);
      if (row.isLocked) throw new Error('Your administrator manages this setting. Ask them to update its model.');
      const result = await host.config.set({ key: row.key, value: '' });
      if (result.deny !== undefined) throw new Error(result.deny);
      rows = rows.map(item => item.key === row.key ? { ...item, value: '' } : item);
      notice = 'Teammates use each role\'s model. New sessions use the saved settings; run /agent-models-apply to use them in this session.';
    } catch (cause) {
      error = message(cause);
    } finally {
      saving = false;
      redraw(host);
    }
  }

  async function saveEffort(host: ModelPickerHost, field: string, value: string, renderedGeneration: number) {
    if (!open || saving || loading || renderedGeneration !== generation || field !== role) return;
    saving = true;
    error = '';
    notice = '';
    redraw(host);
    try {
      rows = await host.config.list();
      if (!open) return;
      const row = effortRow(rows, host.plugin.name, field);
      if (row.isLocked) throw new Error('Your administrator manages this setting. Ask them to update its effort.');
      if (!row.options?.includes(value)) return;
      const result = await host.config.set({ key: row.key, value });
      if (result.deny !== undefined) throw new Error(result.deny);
      if (result.value !== value) throw new Error('The config writer returned a different value. Open /config to inspect the saved setting.');
      rows = rows.map(item => item.key === row.key ? { ...item, value } : item);
      notice = `Saved ${entryLabel(field)} effort. New sessions use the saved settings; run /agent-models-apply to use them in this session.`;
    } catch (cause) {
      error = message(cause);
    } finally {
      saving = false;
      redraw(host);
    }
  }

  async function saveUpkeep(host: ModelPickerHost, value: string, renderedGeneration: number) {
    if (!open || saving || loading || renderedGeneration !== generation || role !== teammateEntry.value) return;
    saving = true;
    error = '';
    notice = '';
    redraw(host);
    try {
      rows = await host.config.list();
      if (!open) return;
      const row = upkeepRow(rows, host.plugin.name);
      if (row.isLocked) throw new Error('Your administrator manages this setting. Ask them to update teammate cache upkeep.');
      if (!row.options?.includes(value)) return;
      const result = await host.config.set({ key: row.key, value });
      if (result.deny !== undefined) throw new Error(result.deny);
      if (result.value !== value) throw new Error('The config writer returned a different value. Open /config to inspect the saved setting.');
      rows = rows.map(item => item.key === row.key ? { ...item, value } : item);
      notice = `Saved teammate cache upkeep. Split-pane teammates launched from now on start in ${value}.`;
    } catch (cause) {
      error = message(cause);
    } finally {
      saving = false;
      redraw(host);
    }
  }

  async function saveCache(host: ModelPickerHost, key: string, value: string, renderedGeneration: number) {
    if (!open || saving || loading || renderedGeneration !== generation) return;
    const limit = key === 'keepalive-limit';
    saving = true;
    error = '';
    notice = '';
    redraw(host);
    try {
      rows = await host.config.list();
      if (!open) return;
      const row = cacheRow(rows, host.plugin.name, key);
      if (row.isLocked) throw new Error(`Your administrator manages this setting. Ask them to update the ${limit ? 'keepalive limit' : 'prompt cache TTL'}.`);
      if (limit ? limitValue(value) !== value : !row.options?.includes(value)) return;
      const result = await host.config.set({ key: row.key, value });
      if (result.deny !== undefined) throw new Error(result.deny);
      if (result.value !== value) throw new Error('The config writer returned a different value. Open /config to inspect the saved setting.');
      rows = rows.map(item => item.key === row.key ? { ...item, value } : item);
      notice = limit ? 'Saved the keepalive limit. It applies to warm and warmcomp after each request from now on.'
        : 'Saved the prompt cache TTL. Conversations that start from now on use it; each one\'s TTL button can change it.';
    } catch (cause) {
      error = message(cause);
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
    if (saved?.session === session && saved.open && entries.some(item => item.value === saved.role)) {
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
    if (terminal && e.presentation.columns < minimumColumns) {
      return { text: `Widen the terminal to at least ${minimumColumns} columns, then run /agent-models.` };
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
    let effort: ConfigRow | undefined;
    let upkeep: ConfigRow | undefined;
    let rowError = '';
    let effortError = '';
    let upkeepError = '';
    if (!loading && configLoaded) {
      try { current = roleRow(rows, host.plugin.name, role); } catch (cause) { rowError = message(cause); }
      try { effort = effortRow(rows, host.plugin.name, role); } catch (cause) { effortError = message(cause); }
      if (role === teammateEntry.value) {
        try { upkeep = upkeepRow(rows, host.plugin.name); } catch (cause) { upkeepError = message(cause); }
      }
    }
    const filtered: ModelEntry[] = filterModels(models, query);
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pages - 1);
    const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
    const field = role;
    const renderedGeneration = generation;
    const search = (text: string) => { if (!saving) { query = text; page = 0; redraw(host); } };
    const act = (operation: () => Promise<void>) => operation().catch(cause => { error = message(cause); redraw(host); });
    const ttlLabel = (fallback?: string) => fallback ? `Default (${fallback})` : 'Default (Claude Code)';
    const cacheSelect = (key: string, label: string, name: (value: string) => string, values?: string[]) => {
      let row: ConfigRow | undefined;
      try { row = cacheRow(rows, host.plugin.name, key); } catch (cause) { return <Text>{message(cause)}</Text>; }
      const value = String(row.value);
      if (row.isLocked || saving) return <Text>{`${label}: ${name(value)}${row.isLocked ? ' · managed by your administrator' : ''}`}</Text>;
      const choices = values ? (values.includes(value) ? values : [...values, value]) : row.options || [];
      return <Select key={key} label={label} value={value} options={choices.map(option => ({ value: option, label: name(option) }))}
        onSelect={value => act(() => saveCache(host, key, value, renderedGeneration))} />;
    };
    const ttlSelect = (key: string, label: string, fallback?: string) => cacheSelect(key, label, value => value === 'default' ? ttlLabel(fallback) : value);
    const customLimit = (text: string) => {
      const value = limitValue(text);
      if (!value) { error = 'Enter default, infinite, or a whole number of keepalives from 1.'; notice = ''; redraw(host); return; }
      return act(() => saveCache(host, 'keepalive-limit', value, renderedGeneration));
    };
    let limitRow: ConfigRow | undefined;
    try { limitRow = cacheRow(rows, host.plugin.name, 'keepalive-limit'); } catch {}
    const teammateDefault = defaults && (defaults.main.ttl === defaults.subagent.ttl ? defaults.main.ttl : `${defaults.main.ttl} split-pane, ${defaults.subagent.ttl} in-process`);
    if (role === cacheEntry.value) {
      return <Box flexDirection="column">
        <Text>Prompt cache TTL: how long the cache lasts between requests. 1h survives longer breaks; each 1h cache write costs 2× instead of 1.25×.</Text>
        {notice ? <Text>{notice}</Text> : null}
        {error ? <Text>{error}</Text> : null}
        {configError ? <Text>{configError}</Text> : null}
        <Box flexDirection="row" gap={1}><Button key="close" label="Close" onPress={() => act(() => close(host))} /></Box>
        <Select key="role" label="Role" value={role} options={entries} onSelect={value => {
          if (saving || !entries.some(item => item.value === value)) return;
          role = value; page = 0; error = ''; notice = ''; redraw(host);
          return act(() => intent(host));
        }} />
        {loading ? <Text>Loading settings…</Text> : configLoaded ? <Box flexDirection="column">
          {ttlSelect('cache-ttl', 'Main conversation', defaults?.main.ttl)}
          {ttlSelect('subagent-ttl', 'Subagents', defaults?.subagent.ttl)}
        </Box> : null}
        <Text dimColor>Default is what Claude Code uses for that conversation with your current settings and sign-in. Each conversation starts in its own setting and its TTL button changes it for that conversation only. Teammates have their own setting under Teammates.</Text>
        {configLoaded && !loading ? cacheSelect('keepalive-limit', 'Keepalive limit', limitLabel, LIMITS) : null}
        {configLoaded && !loading && limitRow && !limitRow.isLocked && !saving
          ? <Input key="keepalive-custom" label="Other number" placeholder="Any whole number, then Enter" value="" onSubmit={customLimit} /> : null}
        <Text dimColor>How many keepalives warm and warmcomp send after each request; warmcomp then compacts. Default (priced) sends them while each costs less than rewriting the cache. Infinite never stops. A number sends exactly that many, whatever they cost. Each keepalive keeps an idle cache about 4½ minutes longer on a 5m TTL, or 59½ minutes on 1h.</Text>
      </Box>;
    }
    const navigate = (offset: number) => {
      if (saving || loading) return;
      page = (page + offset + pages) % pages;
      redraw(host);
    };
    return <Box flexDirection="column">
      <Text>Choose a model for each role. Search by name or ID, then select an entry. Active sessions retain their current assignments.</Text>
      {notice ? <Text>{notice}</Text> : null}
      {error ? <Text>{error}</Text> : null}
      {catalogError ? <Text>{catalogError}</Text> : null}
      {configError ? <Text>{configError}</Text> : null}
      <Box flexDirection="row" gap={1}>
        {saving ? null : <Button key="refresh" label="Refresh catalog" onPress={() => act(() => refresh(host))} />}
        <Button key="close" label="Close" onPress={() => act(() => close(host))} />
      </Box>
      <Select key="role" label="Role" value={role} options={entries} onSelect={value => {
        if (saving || !entries.some(item => item.value === value)) return;
        role = value; page = 0; error = ''; notice = ''; redraw(host);
        return act(() => intent(host));
      }} />
      <Text>{`Saved: ${configError ? 'unavailable' : current?.value || (role === teammateEntry.value ? 'Default (each role\'s model)' : 'Choose a model')}`}</Text>
      {role === teammateEntry.value ? <Text dimColor>Teammates use this model and effort in place of their role's. Default keeps each role's.</Text> : null}
      {role === teammateEntry.value && current?.value && !current.isLocked && !saving
        ? <Button key="teammate-default" label="Use role defaults" onPress={() => act(() => clearTeammate(host, renderedGeneration))} /> : null}
      {current?.isLocked ? <Text>Your administrator manages this setting. Ask them to update its model.</Text> : null}
      {rowError ? <Text>{rowError}</Text> : null}
      {effort && !effort.isLocked && !saving ? <Select key="effort" label="Effort" value={String(effort.value)}
        options={(effort.options || []).map(value => ({ value, label: effortLabel(value) }))}
        onSelect={value => act(() => saveEffort(host, field, value, renderedGeneration))} />
        : effort ? <Text>{`Effort: ${effortLabel(String(effort.value))}${effort.isLocked ? ' · managed by your administrator' : ''}`}</Text> : null}
      {effortError ? <Text>{effortError}</Text> : null}
      {upkeep && !upkeep.isLocked && !saving ? <Select key="teammate-upkeep" label="Cache upkeep" value={String(upkeep.value)}
        options={(upkeep.options || []).map(value => ({ value, label: value }))}
        onSelect={value => act(() => saveUpkeep(host, value, renderedGeneration))} />
        : upkeep ? <Text>{`Cache upkeep: ${String(upkeep.value)}${upkeep.isLocked ? ' · managed by your administrator' : ''}`}</Text> : null}
      {upkeep ? <Text dimColor>Split-pane teammates start in this cache upkeep and can change it from their own bar. In-process teammates and subagents can't be kept warm.</Text> : null}
      {upkeepError ? <Text>{upkeepError}</Text> : null}
      {role === teammateEntry.value && configLoaded && !loading ? ttlSelect('teammate-ttl', 'Cache TTL', teammateDefault) : null}
      <Input key="search" label="Search" placeholder="Name, exact ID, or description" value={query} autoFocus onInput={search} onSubmit={search} />
      {loading ? <Text>Loading endpoint catalog…</Text> : saving ? <Text>Saving model selection…</Text> : !catalogLoaded ? <Text>Catalog unavailable. Resolve the discovery error, then refresh.</Text> : <Box flexDirection="column" gap={1}>
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
