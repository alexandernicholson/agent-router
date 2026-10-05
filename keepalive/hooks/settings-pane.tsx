import type { Args, ConfigRow, EngineInterface } from 'claude-code';
import type { TtlDefault } from '../lib/cache-ttl.js';

export type SettingsHost = {
  plugin: Pick<EngineInterface['plugin'], 'name'>;
  ui: Pick<EngineInterface['ui'], 'invalidate' | 'open' | 'close' | 'log' | 'resolve'>;
  config: Pick<EngineInterface['config'], 'list' | 'set'>;
  command: Pick<EngineInterface['command'], 'register'>;
  ttlDefaults: () => Promise<{ main: TtlDefault; subagent: TtlDefault }>;
};

export const SETTINGS_PANE = 'keepalive-settings';
const FIELDS: Record<string, { field: string; kind: ConfigRow['kind']; label: string }> = {
  'cache-ttl': { field: 'cache_ttl', kind: 'choice', label: 'Main conversation TTL' },
  'subagent-ttl': { field: 'subagent_cache_ttl', kind: 'choice', label: 'Subagent TTL' },
  'teammate-ttl': { field: 'teammate_cache_ttl', kind: 'choice', label: 'Teammate TTL' },
  'teammate-upkeep': { field: 'teammate_cache_upkeep', kind: 'choice', label: 'Teammate upkeep' },
  'keepalive-limit': { field: 'keepalive_limit', kind: 'text', label: 'Keepalive limit' },
};
const LIMITS = ['default', 'infinite', '1', '2', '3', '4', '6', '8', '12', '16', '24'];
const message = (error: unknown) => (error as Error).message;

export const limitValue = (value: string) => {
  const text = value.trim().toLowerCase();
  if (text === 'default' || text === 'infinite') return text;
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? String(Number(text)) : undefined;
};
const limitLabel = (value: string) => value === 'default' ? 'Default (priced)' : value === 'infinite' ? 'Infinite' : value;

function ownedRow(rows: ConfigRow[], plugin: string, key: string): ConfigRow {
  const { field, kind } = FIELDS[key];
  const matches = rows.filter(row => (row.provider.plugin === plugin || row.provider.plugin.startsWith(`${plugin}@`)) && row.key.endsWith(`.${field}`));
  if (matches.length !== 1) throw new Error(`Open /config and check that ${field} has one visible Keepalive setting.`);
  const row = matches[0];
  if (row.kind !== kind) throw new Error(`Open /config to edit ${row.label}; this setting requires its native control.`);
  return row;
}

export function createSettingsPane() {
  let open = false;
  let rows: ConfigRow[] = [];
  let saving = false;
  let error = '';
  let notice = '';
  let defaults: { main: TtlDefault; subagent: TtlDefault } | undefined;

  const redraw = (host: SettingsHost) => host.ui.invalidate('ui.render');
  const dismiss = (host: SettingsHost) => { open = false; return host.ui.close({ id: SETTINGS_PANE }); };

  async function load(host: SettingsHost) {
    defaults = undefined;
    error = '';
    redraw(host);
    try { [rows, defaults] = await Promise.all([host.config.list(), host.ttlDefaults()]); }
    catch (cause) { error = `Settings unavailable: ${message(cause)}`; }
    redraw(host);
  }

  async function show(host: SettingsHost) {
    const opened = await host.ui.open({ id: SETTINGS_PANE, title: 'Keepalive settings', focus: true, closeOnEscape: true });
    if (!opened.isPlaced) { host.ui.log(`Keepalive settings: ${opened.reason}`); return false; }
    open = true;
    notice = '';
    await load(host);
    return true;
  }

  async function save(host: SettingsHost, key: string, value: string) {
    if (!open || saving || !defaults) return;
    saving = true;
    error = '';
    notice = '';
    redraw(host);
    try {
      rows = await host.config.list();
      if (!open) return;
      const row = ownedRow(rows, host.plugin.name, key);
      if (row.isLocked) throw new Error(`Your administrator manages this setting. Ask them to update the ${FIELDS[key].label.toLowerCase()}.`);
      if (key === 'keepalive-limit' ? limitValue(value) !== value : !row.options!.includes(value)) return;
      const result = await host.config.set({ key: row.key, value });
      if (result.deny !== undefined) throw new Error(result.deny);
      if (result.value !== value) throw new Error('The config writer returned a different value. Open /config to inspect the saved setting.');
      rows = rows.map(item => item.key === row.key ? { ...item, value } : item);
      notice = key === 'keepalive-limit' ? 'Saved the keepalive limit. It applies to warm and warmcomp after each request from now on.'
        : key === 'teammate-upkeep' ? `Saved teammate upkeep. Split-pane teammates started from now on begin in ${value}.`
        : 'Saved the prompt cache TTL. Conversations that start from now on use it; each one\'s TTL button can change it.';
    } catch (cause) {
      error = message(cause);
    } finally {
      saving = false;
      redraw(host);
    }
  }

  const commandRun = async (host: SettingsHost, e: Args<'command.run'>) => {
    if (e.presentation.columns < 70) return { text: 'Widen the terminal to at least 70 columns, then run /keepalive-settings.' };
    try { await show(host); return {}; }
    catch (cause) { return { text: `Keepalive settings: ${message(cause)}` }; }
  };

  const uiRender = (host: SettingsHost, e: Args<'ui.render'>) => {
    if (e.requestId !== SETTINGS_PANE || !open) return undefined;
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Box, Text, Button } = host.ui.resolve(e);
      return <Box flexDirection="column"><Text>Open /keepalive-settings in the terminal or desktop to change these settings.</Text>
        <Button key="close" label="Close" onPress={() => { void dismiss(host); }} /></Box>;
    }
    const { Box, Text, Button, Select, Input } = host.ui.resolve(e);
    const choose = (key: string, name: (value: string) => string, values?: string[]) => {
      let row: ConfigRow;
      try { row = ownedRow(rows, host.plugin.name, key); } catch (cause) { return <Text>{message(cause)}</Text>; }
      const value = String(row.value);
      if (row.isLocked || saving) return <Text>{`${FIELDS[key].label}: ${name(value)}${row.isLocked ? ' · managed by your administrator' : ''}`}</Text>;
      const choices = values ? (values.includes(value) ? values : [...values, value]) : row.options!;
      return <Select key={key} label={FIELDS[key].label} value={value} options={choices.map(option => ({ value: option, label: name(option) }))}
        onSelect={(next: string) => { void save(host, key, next); }} />;
    };
    const ttl = (fallback: string) => (value: string) => value === 'default' ? `Default (${fallback})` : value;
    const custom = (text: string) => {
      const value = limitValue(text);
      if (!value) { error = 'Enter default, infinite, or a whole number of keepalives from 1.'; notice = ''; redraw(host); return; }
      void save(host, 'keepalive-limit', value);
    };
    let limitRow: ConfigRow | undefined;
    try { limitRow = ownedRow(rows, host.plugin.name, 'keepalive-limit'); } catch {}
    const body = ({ main, subagent }: { main: TtlDefault; subagent: TtlDefault }) => <Box flexDirection="column">
      <Text bold>Prompt cache TTL</Text>
      {choose('cache-ttl', ttl(main.ttl))}
      {choose('subagent-ttl', ttl(subagent.ttl))}
      {choose('teammate-ttl', ttl(main.ttl === subagent.ttl ? main.ttl : `${main.ttl} split-pane, ${subagent.ttl} in-process`))}
      <Text dimColor>Default is what Claude Code uses with your current settings and sign-in. 1h survives longer breaks; each 1h cache write costs 2× instead of 1.25×.</Text>
      <Text bold>Upkeep</Text>
      {choose('teammate-upkeep', value => value)}
      <Text dimColor>The mode split-pane teammates start in. In-process teammates and subagents can't be kept warm.</Text>
      {choose('keepalive-limit', limitLabel, LIMITS)}
      {limitRow && !limitRow.isLocked && !saving
        ? <Input key="keepalive-custom" label="Other number" placeholder="Any whole number, then Enter" value="" onSubmit={custom} /> : null}
      <Text dimColor>How many keepalives warm and warmcomp send after each request; warmcomp then compacts. Default (priced) sends them while each costs less than rewriting the cache. Infinite never stops. A number sends exactly that many, whatever they cost. Each keepalive keeps an idle cache about 4½ minutes longer on a 5m TTL, or 59½ minutes on 1h.</Text>
    </Box>;
    return <Box flexDirection="column">
      <Text>Defaults each new conversation starts in. Each conversation's own TTL and mode buttons change it for that conversation only.</Text>
      {notice ? <Text>{notice}</Text> : null}
      {error ? <Text>{error}</Text> : null}
      <Box flexDirection="row" gap={1}><Button key="close" label="Close" onPress={() => { void dismiss(host); }} /></Box>
      {defaults ? body(defaults) : <Text>Loading settings…</Text>}
    </Box>;
  };

  return { commandRun, uiRender, close: () => { open = false; },
    register: (host: SettingsHost) => host.command.register({ name: SETTINGS_PANE, description: 'Choose the prompt cache TTLs, teammate upkeep and keepalive limit Keepalive starts each conversation with.' }) };
}
