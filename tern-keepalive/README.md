# Keepalive for Tern

A [Tern](https://docs.stencil.so/tern/) plugin that gives [pi-keepalive](../pi-keepalive/README.md) a native interface when OMP runs in a Tern pane:

- **Status line.** The focused OMP pane's prompt-cache bar sits at the end of Tern's status line in the footer bar's colours: the dial toned by how much cache lifetime is left, a teal diamond for warming and a violet one for compacting (both for `warmcomp`, a hollow faint one when upkeep is off), the mode name, a faint `TTL` label with its value, the hit-rate bar and percentage by grade, misses, the countdown, keepalives left, and faint separators. Token counts stay on the dashboard. Click anywhere on it to open the dashboard. While the plugin runs, OMP's own footer bar is hidden; remove the plugin and it comes back within 20 seconds. The status line shows only while Tern's status bar is on (the `status_bar` command).
- **Dashboard.** A pane per OMP pane: the bar drawn exactly as in the status line (plus the last request's token counts), buttons for the upkeep mode and TTL with the current mode's button in its diamond colour, Now and Session hit-rate meters, the request dot matrix, recent misses, the conversation's lifetime and upkeep lines, and the last 30 requests filtered by kind. **Settings** opens the settings page over it.
- **Settings.** A preferences page over pi-keepalive's `settings.json`: TTL, upkeep, keepalive limit, compaction threshold, client TTLs, price URL, reduced motion. Choices save on click; text rows are typed into (Enter saves, Escape cancels). Every OMP session picks a change up within a second. `PI_KEEPALIVE_*` variables still win over the file.
- **Palette.** Under Keepalive: open the dashboard, open settings, cycle the upkeep mode, set it to `off`, `warm`, `compact` or `warmcomp`, and toggle the TTL between 5m and 1h for the focused pane. Bind any of them in Tern's keybinds (`plugin.keepalive.<id>`).

## Install

Install pi-keepalive into OMP first (see its README), then:

```sh
tern plugin install github.com/alexandernicholson/agent-router/tern-keepalive
# or, from a checkout, keeping it live while you edit:
tern plugin link tern-keepalive
```

New panes get `PI_KEEPALIVE_TERN_DIR` from the plugin's spawn filter. OMP sessions already running find the plugin's data directory without it, but load pi-keepalive only after a restart or `/reload`.

## How it talks to pi-keepalive

Through files in the plugin's data directory (`~/Library/Application Support/Tern/plugin-data/keepalive` on macOS):

| File | Written by | Holds |
|---|---|---|
| `panes/<pane>.json` | pi-keepalive, on change and at least every 5 s | bar, dashboard, settings, defaults and the settings rows |
| `control/<pane>.json` | this plugin | `{seq, queue: [{seq, upkeep?, ttl?}]}`; the extension applies each newer `seq` once, in order |
| `active.json` | this plugin's host half, every 5 s | `{at}` (unix seconds): the heartbeat that hides OMP's footer bar |

A snapshot older than 30 seconds belongs to an OMP that exited and is not shown. Files of closed panes are swept once a minute, all but the newest snapshot, which the settings page reads while no OMP runs.

## Layout

```text
plugin.toml   manifest: host + window halves, the dashboard and settings blocks, status.css
common.luau   the file contract and the status segments, shared by both halves
host.luau     spawn filter, heartbeat, dashboard and settings blocks
window.luau   status segments and palette commands
status.css    the bar's colours and spacing, in the status line and on the dashboard
```

## Develop

```sh
tern plugin link tern-keepalive
tern plugin types tern-keepalive    # writes tern-keepalive/tern.d.luau (ignored by git)
luau-lsp analyze --platform=standard --definitions=@tern=tern-keepalive/tern.d.luau tern-keepalive/*.luau
tern plugin list                    # load errors of the host half
```

Tern reloads a linked plugin on save. With the plugin linked and an OMP pane focused, `tern ctl plugins run plugin.keepalive.dashboard` opens the dashboard and `tern ctl tree '#statusline'` shows the status segment.
