# Keepalive

Keepalive is a Claude Code Mod that shows how well every conversation reuses its prompt cache, and can keep an idle cache from expiring. It works on its own, and with [Agent Router](../agent-router/README.md) when both are installed.

## Capabilities

- A cache bar above the prompt for the conversation in view: the main conversation, a subagent or a teammate, with its hit rate, cache lifetime, time left and recent misses.
- A dashboard with `/keepalive`: the session's hit rate now and overall, one dot per request, every agent as a tree, and the request history with the time between requests.
- A TTL button on each conversation to switch it between 5-minute and 1-hour caching, with per-kind defaults.
- Upkeep that sends cheap keepalives before an idle cache expires, or compacts a large conversation while it is still cached.
- Keepalive costs priced from Anthropic's price table for Claude models and from models.dev for others.

## Requirements

- **Claude Code 2.1.289 or newer with function hooks enabled** (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).
- **Node.js 22 or newer** on `PATH`.

Any endpoint works: a Claude subscription, an API key or an Anthropic-compatible gateway.

## Install

```text
/plugin marketplace add alexandernicholson/agent-router
/plugin install keepalive@agent-router-tools
```

Run `/keepalive-settings` to choose the TTL each kind of conversation starts in, the upkeep split-pane teammates start in, and the keepalive limit.

## With Agent Router

Keepalive reads the routes Agent Router publishes for each session, so with both installed:

- each request is measured against the model Agent Router sent it with, so a routed subagent is never mistaken for a model change;
- the dashboard names subagents and teammates by their role;
- a lead's dashboard finds every split-pane teammate Agent Router launched.

Each plugin works without the other. Keepalive finds split-pane teammates by itself, from their launch flags, so a lead links its teammates even without Agent Router.

### Moving from Agent Router 0.16

The cache bar, `/agent-cache` and the cache settings were part of Agent Router up to 0.16.2. On its first run Keepalive copies the cache history Agent Router recorded, and it keeps using the cache settings you saved in Agent Router until you change them in `/keepalive-settings`.

## The cache bar

The cache bar above the prompt follows the conversation in view: the main conversation, or the subagent or teammate whose transcript you are viewing.

```text
[ ◕ ] ⬦ off TTL 5m ██████████ 96% ✕ 2 prefix · ETA ~3:44 · read 148.1k · write 5.7k · new 2
```

It shows the conversation's cache TTL, its cache hit rate over its last 10 requests, any recent cache misses, the time left before the entry expires, and the last request's tokens read, written, and sent uncached. When a response reports a different TTL than the conversation asked for, the bar adds it, as `· 5m reported`.

The hit rate adds up the read, written and uncached tokens of the conversation's last 10 real requests, so one miss shows without one request hiding the rest. Keepalives and compactions are left out. Right after a compaction the bar shows the compaction's own hit rate.

#### Cache misses

A cache miss leaves a short chip after the hit rate: `✕`, the number of misses in the last 15 minutes, and their most common causes in a word each (`prefix`, `expired`, `model`, `TTL`, or `unknown`). On the main conversation it counts misses across every agent in the session; on a subagent's or teammate's bar, only theirs. It is yellow for five minutes after the latest miss, then dims, and goes away once the last miss is 15 minutes old. It sends no notification and takes no keyboard focus. Click it to open the dashboard filtered to misses, where a line spells them out:

```text
✕ 2 cache misses in the last 15 min: 1 expired, 1 prefix changed · latest 6:25 ago
```

The dial button shows the time left in quarters of the TTL: `●` for a cache just read or written, then `◕`, `◑`, `◔`, and `○` once it has expired. It refills when a request is dispatched, and shows `◌` while there is no reported TTL to count down. Click the dial, or run `/keepalive` (`/agent-cache` still works), to open the dashboard. The first time the bar appears, Keepalive adds a short guide to it in the transcript, once per user; the guide is shown to you only and is never sent to the model.

## Dashboard

The dashboard opens with the whole session at a glance:

```text
Prompt cache · all agents
Now      ██████████ 96% over the last 10 requests
Session  ▓▓▓▓▓▓▓▓▓░ 91% over 42 requests · read 3.1m · write 214k · new 1.2k
●●●●●●●●✕●●●◐●●··●●●●●●●●○●●●●●●●●●●●●●●●◆●●
One dot per request, oldest first: ● good ◐ fair ○ poor ✕ miss · keepalive ◆ compaction
```

**Now** is the hit rate over the last 10 real requests across every agent; **Session** is every request recorded this session. The dot matrix has one cell per request across the whole tree, oldest first, in the colour of its grade, so a run of misses or a slipping cache stands out at once. Up to four rows show; older dots are counted above them.

Below that, the miss line and the upkeep mode, then the filters, under a **Show** heading. The option in use is drawn as a highlighted button and the others are dim, so it is clear what the lists below are showing:

```text
Show
Agents   [ all ] main subagents teammates
Requests [ all ] real keepalives compactions misses
From     [ this agent ] all agents
```

- **Agents** filters the tree to the main conversation, subagents, or teammates.
- **Requests** filters the history to real requests, keepalives, compactions, or misses.
- **From** shows the selected agent's last 30 requests, or the last 30 across every agent in the tree, each named with its agent.

The dashboard then draws every conversation Keepalive has seen as a tree: the main conversation, its subagents and their own subagents, in-process teammates, and linked split-pane teammates with their subagents. Each row shows its dial, upkeep mode, bar, TTL and time left, with its kind beside teammates:

```text
Main                                            ◕ ⬥ warm  ██████████ 96% · TTL 5m · ETA ~3:44
├─ agent-router:scout (a7f3)                    ● –       ██████████ 95% · TTL 5m · ETA ~4:08
│  └─ agent-router:task (b912)                  ◑ –       ▓▓▓▓▓▓▓▓░░ 84% · TTL 5m · ETA ~2:10
├─ probe (c044) · in-process teammate           ◕ –       ██████████ 99% · TTL 5m · ETA ~3:51
└─ Worker (worker@team) · split-pane teammate   ◑ ⬥ warm  ██████████ 97% · TTL 5m · ETA ~2:30
   └─ agent-router:reviewer (d1e2)              ○ –       ▒▒▒░░░░░░░ 31% · prefix changed · expired
```

Select an agent's name to see its recent requests. Each takes one line, in columns, with the time since the request before it in the gap between them:

```text
request       hit          TTL  miss            read  write    new    out  model
f953f9bc:0    ██████ 99%   5m                  50.9k    357      4     87  claude-opus-5-5
↕ 4m 12s
f953f9bc:1    ▒░░░░░ 15%   5m   prefix changed 48.6k   257k      2     20  claude-opus-5-5
↕ 12s
keepalive     ██████ 99%   5m                  51.2k      0     11      4  claude-opus-5-5
```

The TTL column is the TTL the request asked for; when the response reported a different one, it shows both (`1h (5m reported)`).

The hit rate is `cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens + input_tokens)`, rounded down so that 100% means a complete hit. Output tokens are shown separately.

The bar and percentage are graded by the uncached tokens a request cost relative to its context (read, write, and new tokens), since a miss on a large context costs more than the same rate on a small one. Each grade has a colour and a bar shading, so it never rests on colour alone:

| Grade | Colour | Bar | Uncached tokens (write + new) | Hit rate this means |
| --- | --- | --- | --- | --- |
| Good | Blue | `█` | Up to 5% of the context, at least 2k and at most 20k | 95% from 40k to 400k tokens; 98% at 1M; lower on small contexts |
| Fair | Yellow | `▓` | Up to 20% of the context, at least 5k and at most 50k | 80% from 25k to 250k tokens; 95% at 1M |
| Poor | Red | `▒` | More | |

For example, a 90% hit rate on a 10k context is good, and the same rate on a 990k context is poor. The time left uses the same colours: good above two minutes, fair above 30 seconds, and poor in the last 30 seconds, when upkeep acts. The dial repeats it without colour.

When a request rewrites much of what the loop's previous request cached, it is a miss, and the history names the likely cause: **prefix changed** when the cache was still warm, so something early in the prompt changed (in Claude Code, a reloaded skill list, a working-directory notice, or a reminder can do this); **expired** when it outlived the reported TTL; **model changed**, since caches are per model; or **cache miss** when no TTL was reported. Growth at the end of the conversation and small partial misses are not labelled. Counts come from every native `turn.step` response, including intermediate tool steps, rather than from completed-turn totals. Separate agent and session identities keep nested agents, parallel requests, and split-pane teammate main loops distinct. Agents in the live roster without usage show **no observation**, not zero usage.

Request records persist across resume. Repeated request identities count once. The dashboard retains totals for all recorded requests; the 30-request limit applies only to the displayed history. The lead polls linked split-pane teammates every five seconds. A compaction of a loop, by `/compact`, by Claude Code, or by upkeep, shows as `cmpt ✓` with the conversation's size before and after (`cmpt ✓ 343k → 18k`) until the loop's next request; the bar shows the compaction request's own hit rate. The compaction request joins the history and totals, and the countdown clears, since its cache went with the conversation. Historical counts are kept; `/clear` starts a separate cache ledger on the next request.

TTLs come exclusively from response metadata for **every provider**, including third-party gateways. When `usage.cache_creation` contains `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`, the dashboard shows the reported write counts and a lifetime bar for each nonzero bucket. Mixed five-minute and one-hour writes remain separate. This metadata describes newly written tokens. A request that only reads the cache keeps the TTL of the loop's latest reported write, since read tokens keep the TTL they were written with.

Claude Code's native `turn.step` hook currently normalizes usage to four token totals and omits the TTL breakdown. Keepalive first checks the response usage and then recovers the breakdown from a bounded tail of the corresponding main or subagent transcript. Records must match the session, agent, model, request interval, and all four token counts; ambiguous matches are ignored. Delayed transcript writes are checked again after tool use, at agent completion, and for up to 30 seconds after each response. Only usage metadata is persisted; transcript text stays out of cache records.

Claude Code writes a response's TTL breakdown to the transcript a moment after the response. Until it arrives, a request that wrote to the cache counts down from the TTL it asked for, and the dashboard marks that lifetime **awaiting report**. When the report arrives the countdown takes the reported TTL. If no report arrives within 30 seconds, or the metadata is invalid or ambiguous, the bar shows **TTL not reported** for every provider and stops counting down. Once a model has written to the cache without reporting a TTL, its later writes show **TTL not reported** straight away, in every loop, until it reports one: the TTL a conversation asks for does not establish the TTL the provider applied.

The time left uses the reported TTL and the dispatch time of the loop's latest request that read or wrote its cache: an entry's lifetime runs from the start of the request that writes or reads it, and every read refreshes it. A request in flight restarts the countdown when it is dispatched. Mixed five-minute and one-hour writes count down separately, and the bar shows the sooner one still running. Responses carry no expiry timestamp, so the countdown is timed by Claude Code's clock; a bar can show a past cache hit after its entry has expired. The plugin does not set API `cache_control`.

The dashboard distinguishes caching disabled by `DISABLE_PROMPT_CACHING*`, a response with no cached tokens, missing usage, an unreported TTL, and an expired entry. A miss caused by moving a conversation from 5m to 1h is labelled **TTL changed**, since the API writes the cache again at the new lifetime. It does not name the prompt change behind other misses or claim authoritative upstream billing.

## Cache TTL

Each conversation has its own prompt cache TTL, 5 minutes or 1 hour. The `TTL 5m` button on the bar shows the TTL of the conversation in view; click it to switch that conversation between 5m and 1h. The change applies to that conversation's next request and to no other: switching the main conversation never changes a subagent's or teammate's TTL, and switching a subagent changes only that subagent.

A conversation starts in its own default, set with `/keepalive-settings`:

| Conversation | Setting | `/keepalive-settings` row |
| --- | --- | --- |
| Main conversation | `cache_ttl` | **Main conversation TTL** |
| Each subagent | `subagent_cache_ttl` | **Subagent TTL** |
| Each teammate, in-process or split-pane | `teammate_cache_ttl` | **Teammate TTL** |

Each setting is **Default** unless you change it. The picker and the bar show what Default means for you: the TTL Claude Code uses with your current environment, settings, and sign-in, worked out without sending a request. For the main conversation that is `CLAUDE_CODE_PROMPT_CACHE_TTL`, then `promptCacheTtl` in your Claude Code settings, then `ENABLE_PROMPT_CACHING_1H`, and otherwise 1h on a Claude subscription and 5m with an API key or gateway. Subagents and teammates follow `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` and `subagentPromptCacheTtl` the same way, and otherwise 5m. The dashboard names the source under each conversation, for example `TTL 5m · Claude Code default for API keys and gateways`. With `FORCE_PROMPT_CACHING_5M` set, every TTL is 5m and the button is shown without being clickable.

A choice made with the button lasts for that conversation in its session, including after a reload; a new session starts from the defaults. Keepalives and Keepalive's compactions use the main conversation's TTL, so they refresh the cache the main conversation reads.

1-hour cache writes cost 2× the input price instead of 1.25×, so switching a conversation to 1h writes its whole context once at the higher price; switching back to 5m keeps the cache. Keepalive cost estimates use the model's own 1-hour write price when its price source lists one (see **Model prices**). Keepalive sets the TTL through Claude Code's `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` variables for the requests it applies to, so a value you set in your own environment remains the default and returns when you switch back to it. Parallel subagents with different TTLs take turns starting their requests, one TTL at a time.

### Colours and accessibility

Every colour is text or a mark on the terminal's own background; nothing is drawn as text on a coloured fill, whose contrast a plugin cannot control. Keepalive picks a dark or light palette from Claude Code's `theme` setting (`auto` follows `COLORFGBG` where the terminal sets it, otherwise dark), and checks every value in its tests:

| Colour | Dark | Light |
| --- | --- | --- |
| Good | `#19affe` | `#0268d0` |
| Fair | `#fadf27` | `#9d580c` |
| Poor | `#fe626c` | `#7a0d3f` |
| `warm` marker | `#12efc6` | `#0b8a6c` |
| `compact` marker | `#8a74ff` | `#5d05a4` |

- The grades colour text, and reach WCAG contrast of 4.5:1 on black, `#1e1e1e` and `#282c34`, or on white, `#f0f0f0` and `#fdf6e3`. The mode markers reach the 3:1 that non-text marks need.
- Grades differ from each other, and markers from each other, by at least ΔE 15 (OKLab ×100) under normal vision and ΔE 8 under simulated protanopia, deuteranopia and tritanopia (Machado 2009). No marker comes within ΔE 15 of a grade.
- Blue, yellow and red stay apart for every kind of colour vision, the reason good is blue rather than green. Shading repeats each grade, the dial repeats the time left, and words name each mode and miss.

## Cache upkeep

The mode button next to the dial shows the current upkeep mode for the main conversation; click it, or focus it and press Enter, to switch to the next mode: `off` → `warm` → `compact` → `warmcomp` → `off`. A marker before the mode shows its colour: teal `⬥` for `warm`, violet `⬥` for `compact`, both for `warmcomp`, and a dim `⬦` for `off`, which sends nothing. The choice lasts for the session, including after a reload or `/clear`; a new session starts with **off**.

| Mode | What happens 30 seconds before the main conversation's TTL ends |
| --- | --- |
| `off` (default) | Nothing. No requests are sent. |
| `warm` | A keepalive request: one tool-less request over the conversation as last sent, asking for `OK`. Its prompt-cache read refreshes the entry. |
| `compact` | The conversation is compacted, as `/compact` does, while its cache is still warm, if its context is 100k tokens or larger. |
| `warmcomp` | Keepalives as in `warm`. Once the keepalive limit is reached, the conversation is compacted as in `compact` instead; a conversation under 100k tokens is left to expire. |

Upkeep acts only while no main-conversation request is in flight, and at most once per countdown. After a compaction there is no countdown until your next request, so each mode compacts at most once per idle stretch. Upkeep needs a reported TTL, so it does nothing while the TTL is unknown.

Upkeep reaches only conversations that are their own Claude Code session:

| Conversation | Bar and dashboard | Upkeep |
| --- | --- | --- |
| The main conversation | Yes | Its mode button |
| A split-pane teammate | Yes, in its pane and on the lead's dashboard | Its own mode button; starts in `teammate_cache_upkeep` |
| Subagents, at any depth | Yes | None, shown as `–` |
| In-process teammates | Yes | None, shown as `–` |

Claude Code's keepalive and compaction calls act on a session's main conversation only, with no way to name a subagent or an in-process teammate, so those rows show `–` instead of a mode, and the dashboard says so while it shows such a row. Viewing one of their transcripts shows its bar with `–` and no mode button. A split-pane teammate runs as its own session, so it has its own mode: it starts in the **Teammate upkeep** chosen with `/keepalive-settings` (`off` unless you change it), and its mode button can change it from then on. The lead's own mode never changes a teammate's. Teammates read the setting when they start, so a change applies to teammates launched afterwards.

### Keepalive limit

The **Keepalive limit** in `/keepalive-settings` (`keepalive_limit`) sets how many keepalives `warm` and `warmcomp` send after each real request:

| Value | Keepalives after each request | Then |
| --- | --- | --- |
| `default` | While each costs less than rewriting the cache, as below | `warm` stops; `warmcomp` compacts |
| A whole number, such as `12` | Exactly that many, whatever they cost, priced or not | `warm` stops; `warmcomp` compacts |
| `infinite` | Until your next request | Never compacts |

Pick a common number from the list or type any whole number into **Other number**. Each keepalive keeps an idle cache about 4½ minutes longer on a 5m TTL, or 59½ minutes on 1h, so 12 keepalives keep a 5m cache for about 55 minutes. A number or `infinite` needs no price, so keepalives are sent for models no price source lists.

Keepalives are billed: each reads the cached context at the cache-read rate and adds a few uncached and output tokens. With the `default` limit, warming pauses once the keepalives since the last request, plus one more, would cost more than letting the entry expire and writing the cached context again. Each keepalive's measured tokens are priced as multiples of the model's input price, taken from Anthropic's price table for Claude models and from [models.dev](https://models.dev) otherwise: the cache-read, cache-write, and output prices (see **Model prices** below). With Claude Opus 5.5's listed prices that is about 23 keepalives on a 5-minute TTL, roughly an hour and 50 minutes of idle time; with the more common 0.1× cache reads, about 11, roughly 55 minutes. That point is when `warmcomp` compacts: until then each keepalive costs less than the rewrite it prevents, and past it only a shorter conversation makes your return cheaper. Your gateway's own pricing may differ from the public listing. A real request resets the count. In `warm` and `warmcomp`, the bar shows how many keepalives are left: `↻11` for 11 more, or `↻∞` with an `infinite` limit. On a `warmcomp` conversation large enough to compact, it shows `↻11 ➜ cmpt`, then `➜ cmpt` once the next action is the compaction. The dashboard spells this out (`11 keepalives, then compact`) and adds how many have been sent since your last request. With `default`, the count assumes each remaining keepalive costs what the last one did, so it can shift by one after the first. Keepalives only pay off if you return to the conversation; if you don't, they are spent for nothing. Keepalives appear in the dashboard's request history and totals, but not in the bar's hit rate. A keepalive sent after a compaction would replay the summary without a cache breakpoint on it, so no mode warms a compacted conversation. Compaction runs only between turns; if it is refused, the debug log says why.

### Model prices

Keepalive costs come from price sources, asked in order for any model the earlier ones did not price. In `warm` and `warmcomp` with the `default` keepalive limit, the panel looks up the main conversation's model once an hour, and the dashboard names the source that priced it.

1. **Anthropic pricing.** The [prompt caching price table](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing) for every Claude model, including 1-hour cache writes at 2× input, as built into Keepalive (checked 2026-10-05). It prices Claude models however a gateway, Bedrock, or Google Cloud spells them, with no download.
2. **models.dev.** The public [models.dev](https://models.dev) catalog, for everything else. It lists 5-minute cache writes only, so a 1-hour cache it prices is costed at its 5-minute write price: warming stops sooner than the exact price would allow, never later.

The models.dev source works as follows:

- **One download for every window.** The catalog is stored as a small price file in the plugin's data directory and refreshed once a day, with its `ETag`, so an unchanged catalog costs a short `304` response. When several Claude Code windows refresh at once, one fetches while the rest keep using the stored file. A refresh lease left by a window that exits expires after two minutes, and a failed refresh is retried an hour later while the old prices stay in use. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set, Keepalive never downloads the catalog and only uses a file that already exists.
- **Matching a model name.** Names are reduced to their family words and version numbers, ignoring case, provider and region prefixes (`anthropic/`, `us.anthropic.`), `[1m]`, `@default`, `-v1:0` and the word `claude`. So `claude-opus-5-5[1m]`, `us.anthropic.claude-opus-5-5-v1:0`, `claude-opus-5-5@default` and `anthropic/claude-opus-5.5` all match Claude Opus 5.5. A name matches only when every word and number agrees, so `claude-opus-5-6` never borrows Opus 5.5's prices, and a variant such as `-fast` matches only its own listing. A dated snapshot uses its own listing when there is one.
- **Which listing.** When the model's maker lists it, that listing is used; otherwise the listings from resellers and clouds must agree, at least two thirds of them within 3% on the cache-read multiple, or the model counts as unpriced. Prices are used as multiples of the listing's own input price, so regional and reseller markups cancel out.
- **Unpriced models.** A name without both a family word and a version, such as a gateway's own alias, is never matched. Its row in the dashboard says **no price found**, and with the `default` keepalive limit no keepalives are sent for it; `warmcomp` goes straight to compacting. A number or `infinite` limit still warms it. The dashboard names the listing a priced model matched.

Checked against the current catalog (8,389 listings across 226 providers): 128 spellings of the 16 first-party Claude models all matched their own prices; 51 unreleased versions and variants of them matched nothing; all 13 Claude models a gateway advertised matched, and none of its 6 custom aliases did. Across the whole catalog, removing a listing and matching its name against the rest found the same model in 93% of the matches where both listings name one. Each of the other 7% matched a listing whose name reads the same but which models.dev files under a different canonical model (for example, `deepseek/deepseek-v4-flash` is filed under `deepseek-v4.1-flash`); a name alone cannot tell those apart, and none of them is a Claude model.

The [prompt-cache-control reference mod](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods/observability/prompt-cache-control), installed with `npx claude-code-templates@latest --mod observability/prompt-cache-control`, monitors the main conversation. Keepalive implements its own per-agent dashboard; that mod is not required. The `/keepalive` command remains distinct from its `/cache` command.

## Storage

Keepalive keeps cache records in its own data directory, normally `~/.claude/plugins/data/keepalive-agent-router-tools/`: session and agent identities, request timestamps, token counts, response TTL metadata and the price file. Prompts, answers and credentials are never stored. It only reads Agent Router's published routes, in `~/.claude/plugins/data/agent-router-agent-router-tools/published/`.

## License

MIT
