import type { Args, ConfigRow, EngineInterface } from 'claude-code';
import type { TtlDefault } from '../lib/cache-ttl.js';
import { parseTtlOverrides } from '../lib/cache.js';

export type SettingsHost = {
  plugin: Pick<EngineInterface['plugin'], 'name'>;
  ui: Pick<EngineInterface['ui'], 'invalidate' | 'open' | 'close' | 'log' | 'resolve'>;
  config: Pick<EngineInterface['config'], 'list' | 'set'>;
  command: Pick<EngineInterface['command'], 'register'>;
  ttlDefaults: () => Promise<{ main: TtlDefault; subagent: TtlDefault }>;
};

export const SETTINGS_PANE = 'keepalive-settings';
const LIMITS = ['default', 'infinite', '1', '2', '3', '4', '6', '8', '12', '16', '24'];
const THRESHOLDS = ['25k', '50k', '100k', '150k', '200k', '300k', '500k'];
const UNITS: Record<string, number> = { '': 1, k: 1000, m: 1000000 };
const message = (error: unknown) => (error as Error).message;

export const limitValue = (value: string) => {
  const text = value.trim().toLowerCase();
  if (text === 'default' || text === 'infinite') return text;
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? String(Number(text)) : undefined;
};
export const thresholdValue = (value: string) => {
  const match = /^([1-9]\d*)([km]?)$/.exec(value.trim().toLowerCase());
  const tokens = match ? Number(match[1]) * UNITS[match[2]] : NaN;
  if (!Number.isSafeInteger(tokens)) return undefined;
  return tokens % 1000 ? String(tokens) : `${tokens / 1000}k`;
};
const limitLabel = (value: string) => value === 'same' ? 'Same as keepalive limit' : value === 'default' ? 'Default (priced)' : value === 'infinite' ? 'Infinite' : value;
const FALLBACKS = ['off', '5m', '15m', '30m', '45m', '1h'];
const fallbackLabel = (value: string) => value === 'off' ? 'Off (monitor only)' : value;
const thresholdLabel = (value: string) => value === '100k' ? '100k (default)' : value;

type Typed = { parse: (value: string) => string | undefined; hint: string; placeholder: string; label?: string };
const ttlSaved = () => 'Saved the prompt cache TTL. Conversations that start from now on use it; each one\'s TTL button can change it.';
const FIELDS: Record<string, { field: string; kind: ConfigRow['kind']; label: string; saved: (value: string) => string; typed?: Typed }> = {
  'cache-ttl': { field: 'cache_ttl', kind: 'choice', label: 'Main conversation TTL', saved: ttlSaved },
  'subagent-ttl': { field: 'subagent_cache_ttl', kind: 'choice', label: 'Subagent TTL', saved: ttlSaved },
  'teammate-ttl': { field: 'teammate_cache_ttl', kind: 'choice', label: 'Teammate TTL', saved: ttlSaved },
  'cache-upkeep': { field: 'cache_upkeep', kind: 'choice', label: 'Main conversation upkeep',
    saved: value => `Saved main conversation upkeep. Sessions started from now on begin in ${value}; this one's mode button changes it here.` },
  'teammate-upkeep': { field: 'teammate_cache_upkeep', kind: 'choice', label: 'Teammate upkeep',
    saved: value => `Saved teammate upkeep. Split-pane teammates started from now on begin in ${value}.` },
  'keepalive-limit': { field: 'keepalive_limit', kind: 'text', label: 'Keepalive limit',
    saved: () => 'Saved the keepalive limit. It applies to warm and warmcomp after each request from now on.',
    typed: { parse: limitValue, hint: 'Enter default, infinite, or a whole number of keepalives from 1.', placeholder: 'Any whole number, then Enter' } },
  'teammate-limit': { field: 'teammate_keepalive_limit', kind: 'text', label: 'Teammate keepalive limit',
    saved: () => 'Saved the teammate keepalive limit. Split-pane teammates started from now on use it.',
    typed: { parse: value => value.trim().toLowerCase() === 'same' ? 'same' : limitValue(value),
      hint: 'Enter same, default, infinite, or a whole number of keepalives from 1.', placeholder: 'Any whole number, then Enter' } },
  'unreported-ttl': { field: 'unreported_ttl', kind: 'choice', label: 'TTL for models that don\'t report one',
    saved: value => `Saved. Models without a reported or gateway-published lifetime ${value === 'off' ? 'are monitored only' : `are kept warm for ${value}`}, from the next request on.` },
  'unreported-ttl-models': { field: 'unreported_ttl_models', kind: 'text', label: 'TTL for specific models',
    saved: () => 'Saved the per-model TTLs. They apply from the next request on.',
    typed: { parse: value => parseTtlOverrides(value).length ? value.trim() : undefined,
      hint: 'Enter model=ttl pairs, such as kimi*=15m, glm-5.3=off (ttl: off, 5m, 15m, 30m, 45m, 1h).', placeholder: 'kimi*=15m, glm-5.3=off, then Enter', label: 'Model TTLs' } },
  'price-url': { field: 'keepalive_price_url', kind: 'text', label: 'Price feed URL',
    saved: () => 'Saved the price feed URL. It is used for models priced from now on.',
    typed: { parse: value => /^(off|https?:\/\/\S+)?$/i.test(value.trim()) ? value.trim() : undefined,
      hint: 'Enter an https:// URL, off, or leave empty to use your gateway.', placeholder: 'https://…/prices.json, then Enter', label: 'Price feed URL' } },
  'compact-threshold': { field: 'compact_threshold', kind: 'text', label: 'Compaction threshold',
    saved: value => `Saved the compaction threshold. compact and warmcomp compact conversations of ${value} tokens or more from now on.`,
    typed: { parse: thresholdValue, hint: 'Enter a number of tokens, such as 80k or 80000.', placeholder: 'Tokens, such as 80k, then Enter' } },
};

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
      const { typed } = FIELDS[key];
      if (typed ? typed.parse(value) !== value : !row.options!.includes(value)) return;
      const result = await host.config.set({ key: row.key, value });
      if (result.deny !== undefined) throw new Error(result.deny);
      if (result.value !== value) throw new Error('The config writer returned a different value. Open /config to inspect the saved setting.');
      rows = rows.map(item => item.key === row.key ? { ...item, value } : item);
      notice = FIELDS[key].saved(value);
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
    const custom = (key: string, typed: Typed) => (text: string) => {
      const value = typed.parse(text);
      if (!value) { error = typed.hint; notice = ''; redraw(host); return; }
      void save(host, key, value);
    };
    const other = (key: string) => {
      const typed = FIELDS[key].typed!;
      let row: ConfigRow | undefined;
      try { row = ownedRow(rows, host.plugin.name, key); } catch {}
      return row && !row.isLocked && !saving
        ? <Input key={`${key}-custom`} label={typed.label ?? 'Other number'} placeholder={typed.placeholder} value="" onSubmit={custom(key, typed)} /> : null;
    };
    const body = ({ main, subagent }: { main: TtlDefault; subagent: TtlDefault }) => <Box flexDirection="column">
      <Text bold>Prompt cache TTL</Text>
      {choose('cache-ttl', ttl(main.ttl))}
      {choose('subagent-ttl', ttl(subagent.ttl))}
      {choose('teammate-ttl', ttl(main.ttl === subagent.ttl ? main.ttl : `${main.ttl} split-pane, ${subagent.ttl} in-process`))}
      <Text dimColor>Default is what Claude Code uses with your current settings and sign-in. 1h survives longer breaks; each 1h cache write costs 2× instead of 1.25×.</Text>
      <Text bold>Upkeep</Text>
      {choose('cache-upkeep', value => value)}
      {choose('teammate-upkeep', value => value)}
      <Text dimColor>The mode each new session's main conversation and each split-pane teammate start in. In-process teammates and subagents can't be kept warm.</Text>
      {choose('keepalive-limit', limitLabel, LIMITS)}
      {other('keepalive-limit')}
      {choose('teammate-limit', limitLabel, ['same', ...LIMITS])}
      {other('teammate-limit')}
      <Text dimColor>How many keepalives warm and warmcomp send after each request; warmcomp then compacts. Default (priced) sends them while each costs less than rewriting the cache. Infinite never stops. A number sends exactly that many, whatever they cost. Each keepalive keeps an idle cache about 4½ minutes longer on a 5m TTL, or 59½ minutes on 1h. Split-pane teammates use the keepalive limit unless given their own.</Text>
      {choose('compact-threshold', thresholdLabel, THRESHOLDS)}
      {other('compact-threshold')}
      <Text bold>Models that don't report a cache lifetime</Text>
      {choose('unreported-ttl', fallbackLabel, FALLBACKS)}
      {choose('unreported-ttl-models', value => value || 'None', [''])}
      {other('unreported-ttl-models')}
      <Text dimColor>The lifetime Keepalive assumes when neither the provider nor your gateway gives one, so warm, compact and warmcomp can work. A gateway's own lifetime always wins; Claude is never affected. Overrides look like kimi*=15m, glm-5.3=off. Icons: ◉ provider-reported, ✦ gateway-learned, ▣ documented, ◇ gateway default, ✎ your setting, ⊘ no cache, ◌ unknown.</Text>
      {other('price-url')}
      <Text dimColor>{`Price feed: ${(() => { try { return String(ownedRow(rows, host.plugin.name, 'price-url').value) || 'your gateway'; } catch { return 'unavailable'; } })()}. Prices decide whether a keepalive is worth its cost.`}</Text>
      <Text dimColor>The smallest conversation compact and warmcomp compact. A smaller one is left to expire, since rewriting its cache costs little.</Text>
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
    register: (host: SettingsHost) => host.command.register({ name: SETTINGS_PANE, description: 'Choose the prompt cache TTLs, upkeep modes, keepalive limits and compaction threshold Keepalive starts each conversation with.' }) };
}
