import type { Args, ConfigRow, EngineInterface, RenderChildren } from 'claude-code';
import type { TtlDefault } from '../lib/cache-ttl.js';
import { parseTtlOverrides } from '../lib/cache.js';
import { VERSION } from '../lib/version.js';
import { displayText } from '../lib/shared/text.js';

export type SettingsHost = {
  plugin: Pick<EngineInterface['plugin'], 'name'>;
  ui: Pick<EngineInterface['ui'], 'invalidate' | 'open' | 'close' | 'log' | 'resolve'>;
  config: Pick<EngineInterface['config'], 'list' | 'set'>;
  command: Pick<EngineInterface['command'], 'register'>;
  ttlDefaults: () => Promise<{ main: TtlDefault; subagent: TtlDefault }>;
  store: Pick<EngineInterface['store'], 'get' | 'set' | 'delete'>;
  release: () => { latest: string; hint: string } | null;
};

export const SETTINGS_PANE = 'keepalive-settings';
const NOTICE_KEY = 'settings-notice';
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
const limitLabel = (value: string) => value === 'same' ? 'Same as above' : value === 'default' ? 'Default (priced)' : value === 'infinite' ? 'Infinite' : value;
const FALLBACKS = ['off', '5m', '15m', '30m', '45m', '1h'];
const fallbackLabel = (value: string) => value === 'off' ? 'Off (monitor only)' : value;
const thresholdLabel = (value: string) => value === '100k' ? '100k (default)' : value;
const LABEL_WIDTH = 19;
const CONTROL_WIDTH = 21;
const FIELD_WIDTH = 26;

type Typed = { parse: (value: string) => string | undefined; hint: string; placeholder: string };
const ttlSaved = () => 'Saved. New conversations start with this TTL.';
const FIELDS: Record<string, { field: string; kind: ConfigRow['kind']; label: string; name: string; saved: (value: string) => string; typed?: Typed }> = {
  'cache-ttl': { field: 'cache_ttl', kind: 'choice', label: 'Main conversation', name: 'main conversation TTL', saved: ttlSaved },
  'subagent-ttl': { field: 'subagent_cache_ttl', kind: 'choice', label: 'Subagents', name: 'subagent TTL', saved: ttlSaved },
  'teammate-ttl': { field: 'teammate_cache_ttl', kind: 'choice', label: 'Teammates', name: 'teammate TTL', saved: ttlSaved },
  'cache-upkeep': { field: 'cache_upkeep', kind: 'choice', label: 'Main conversation', name: 'main conversation upkeep',
    saved: value => `Saved. New sessions start in ${value}; this one's mode button changes it here.` },
  'teammate-upkeep': { field: 'teammate_cache_upkeep', kind: 'choice', label: 'Teammates', name: 'teammate upkeep',
    saved: value => `Saved. New split-pane teammates start in ${value}.` },
  'keepalive-limit': { field: 'keepalive_limit', kind: 'text', label: 'Keepalive limit', name: 'keepalive limit',
    saved: () => 'Saved. warm and warmcomp use it after the next request.',
    typed: { parse: limitValue, hint: 'Type default, infinite, or a whole number of keepalives from 1.', placeholder: 'or type a number' } },
  'teammate-limit': { field: 'teammate_keepalive_limit', kind: 'text', label: 'Teammate limit', name: 'teammate keepalive limit',
    saved: () => 'Saved. New split-pane teammates use it.',
    typed: { parse: value => value.trim().toLowerCase() === 'same' ? 'same' : limitValue(value),
      hint: 'Type same, default, infinite, or a whole number of keepalives from 1.', placeholder: 'or type a number' } },
  'compact-threshold': { field: 'compact_threshold', kind: 'text', label: 'Compact from', name: 'compaction threshold',
    saved: value => `Saved. compact and warmcomp compact conversations of ${value} tokens or more.`,
    typed: { parse: thresholdValue, hint: 'Type a number of tokens, such as 80k or 80000.', placeholder: 'or type e.g. 80k' } },
  'unreported-ttl': { field: 'unreported_ttl', kind: 'choice', label: 'Assumed TTL', name: 'TTL for models that don\'t report one',
    saved: value => `Saved. Models with no reported lifetime ${value === 'off' ? 'are monitored only' : `are kept warm for ${value}`} from the next request.` },
  'unreported-ttl-models': { field: 'unreported_ttl_models', kind: 'text', label: 'Per model', name: 'TTL for specific models',
    saved: () => 'Saved. The per-model TTLs apply from the next request.',
    typed: { parse: value => parseTtlOverrides(value).length ? value.trim() : undefined,
      hint: 'Type model=ttl pairs, such as kimi*=15m, glm-5.3=off (ttl: off, 5m, 15m, 30m, 45m, 1h).', placeholder: 'or type kimi*=15m' } },
  'price-url': { field: 'keepalive_price_url', kind: 'text', label: 'Price feed', name: 'price feed URL',
    saved: () => 'Saved. The next price lookup uses it.',
    typed: { parse: value => /^(off|https?:\/\/\S+)?$/i.test(value.trim()) ? value.trim() : undefined,
      hint: 'Type an https:// URL, off, or nothing to use your gateway.', placeholder: 'or type a URL' } },
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

  async function load(host: SettingsHost, reloaded = false) {
    defaults = undefined;
    error = '';
    redraw(host);
    if (reloaded) {
      const stored = await host.store.get(NOTICE_KEY).catch(() => undefined);
      notice = typeof stored === 'string' ? stored : '';
    }
    await host.store.delete(NOTICE_KEY).catch(() => undefined);
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
      if (row.isLocked) throw new Error(`Your administrator manages this setting. Ask them to update the ${FIELDS[key].name}.`);
      const { typed } = FIELDS[key];
      if (typed ? typed.parse(value) !== value : !row.options!.includes(value)) return;
      const result = await host.config.set({ key: row.key, value });
      if (result.deny !== undefined) throw new Error(result.deny);
      if (result.value !== value) throw new Error('The config writer returned a different value. Open /config to inspect the saved setting.');
      rows = rows.map(item => item.key === row.key ? { ...item, value } : item);
      notice = FIELDS[key].saved(value);
      await host.store.set(NOTICE_KEY, notice).catch(() => undefined);
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
    if (e.requestId !== SETTINGS_PANE) return undefined;
    if (!open) {
      open = true;
      void load(host, true);
    }
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Box, Text, Button } = host.ui.resolve(e);
      return <Box flexDirection="column"><Text>Open /keepalive-settings in the terminal or desktop to change these settings.</Text>
        <Button key="close" label="Close" onPress={() => { void dismiss(host); }} /></Box>;
    }
    const { Box, Text, Button, Select, Input } = host.ui.resolve(e);
    const field = (key: string) => {
      const typed = FIELDS[key].typed;
      let row: ConfigRow | undefined;
      try { row = ownedRow(rows, host.plugin.name, key); } catch {}
      if (!typed || !row || row.isLocked || saving) return null;
      return <Box borderStyle="round" borderDimColor paddingX={1} width={FIELD_WIDTH}>
        <Input key={`${key}-custom`} placeholder={typed.placeholder} value="" submitLabel="save" onSubmit={custom(key, typed)} /></Box>;
    };
    const line = (key: string, control: RenderChildren) => <Box flexDirection="row" alignItems="center">
      <Box width={LABEL_WIDTH} flexShrink={0}><Text>{FIELDS[key].label}</Text></Box><Box width={CONTROL_WIDTH} flexShrink={0}>{control}</Box>{field(key)}</Box>;
    const choose = (key: string, name: (value: string) => string, values?: string[]) => {
      let row: ConfigRow;
      try { row = ownedRow(rows, host.plugin.name, key); } catch (cause) { return line(key, <Text>{message(cause)}</Text>); }
      const value = String(row.value);
      if (row.isLocked || saving) return line(key, <Text>{`${name(value)}${row.isLocked ? ' · managed by your administrator' : ''}`}</Text>);
      const choices = values ? (values.includes(value) ? values : [...values, value]) : row.options!;
      return line(key, <Select key={key} value={value} options={choices.map(option => ({ value: option, label: name(option) }))}
        onSelect={(next: string) => { void save(host, key, next); }} />);
    };
    const ttl = (fallback: string) => (value: string) => value === 'default' ? `Default (${fallback})` : value;
    const custom = (key: string, typed: Typed) => (text: string) => {
      const value = typed.parse(text);
      if (!value) { error = typed.hint; notice = ''; redraw(host); return; }
      void save(host, key, value);
    };
    const section = (title: string, children: RenderChildren[], note: string) => <Box flexDirection="column">
      <Text bold>{title}</Text>{children}<Text dimColor>{note}</Text></Box>;
    const feed = (() => { try { return displayText(String(ownedRow(rows, host.plugin.name, 'price-url').value), 200) || 'your gateway'; } catch { return 'unavailable'; } })();
    const body = ({ main, subagent }: { main: TtlDefault; subagent: TtlDefault }) => <Box flexDirection="column" gap={1}>
      {section('Prompt cache TTL', [choose('cache-ttl', ttl(main.ttl)), choose('subagent-ttl', ttl(subagent.ttl)),
        choose('teammate-ttl', ttl(main.ttl === subagent.ttl ? main.ttl : `${main.ttl} split-pane, ${subagent.ttl} in-process`))],
        'Default is Claude Code\'s choice. 1h writes cost 2×, 5m 1.25×.')}
      {section('Upkeep', [choose('cache-upkeep', value => value), choose('teammate-upkeep', value => value),
        choose('keepalive-limit', limitLabel, LIMITS), choose('teammate-limit', limitLabel, ['same', ...LIMITS]),
        choose('compact-threshold', thresholdLabel, THRESHOLDS)],
        'Default (priced): keepalives while cheaper than a rewrite.')}
      {section('Models that report no cache lifetime', [choose('unreported-ttl', fallbackLabel, FALLBACKS),
        choose('unreported-ttl-models', value => value ? displayText(value, 20) : 'None', ['']), line('price-url', <Text wrap="truncate-end">{feed}</Text>)],
        'Used when the provider and gateway report none; never for Claude.')}
      <Text dimColor>Type into a boxed field and press Enter to save it.</Text>
    </Box>;
    const update = host.release();
    return <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Keepalive settings</Text>
        <Box flexDirection="row" gap={2}>
          {update ? <Button key="keepalive-update" label={`⬆ ${update.latest} available`} plain onPress={() => host.ui.log(update.hint)} /> : null}
          <Text dimColor>{`Keepalive ${VERSION}`}</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Text dimColor>Defaults for new conversations; each bar changes only its own.</Text>
        {notice ? <Text>{notice}</Text> : null}
        {error ? <Text>{error}</Text> : null}
      </Box>
      {defaults ? body(defaults) : <Text>Loading settings…</Text>}
      <Box flexDirection="row"><Button key="close" label="Close" onPress={() => { void dismiss(host); }} /></Box>
    </Box>;
  };

  return { commandRun, uiRender, close: () => { open = false; },
    register: (host: SettingsHost) => host.command.register({ name: SETTINGS_PANE, description: 'Choose the prompt cache TTLs, upkeep modes, keepalive limits and compaction threshold Keepalive starts each conversation with.' }) };
}
