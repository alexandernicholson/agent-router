--!strict
-- keepalive, host half: tells new panes where to publish (the spawn filter), beats the heartbeat that hands the cache
-- bar from omp's footer to Tern's status line, and defines the Keepalive dashboard and settings blocks.

local common = require("./common")
local ui = tern.ui

local HEARTBEAT_EVERY = 5 -- seconds; the extension trusts a heartbeat for 20

-- Every new shell, and so every omp started in one, learns where this plugin's data lives.
tern.on("spawn", function(spec: SpawnSpec): SpawnSpec?
	spec.env.PI_KEEPALIVE_TERN_DIR = tern.plugin.data
	return spec
end)

local function heartbeat()
	local ok, err = pcall(function()
		tern.fs.mkdir(tern.plugin.data)
		tern.fs.write(`{tern.plugin.data}/active.json`, tern.json.encode({ at = os.time() }))
	end)
	if not ok then
		tern.log.warn("keepalive heartbeat failed", err)
	end
end

local function with(node: Node, props: { [string]: any }): Node
	local p: { [string]: any } = node.p or {}
	for k, v in props do
		p[k] = v
	end
	node.p = p
	return node
end

local function chip(text: string, action: string, on: boolean): Node
	return with(ui.badge(text, if on then "accent" else "muted"), { key = action, actions = { click = action } })
end

----------------------------------------------------------------------------------------------------------------------
-- Settings: a prefs page over pi-keepalive's settings.json, as its own block or as a sheet over the dashboard.

type Editing = { row: string, draft: string?, cursor: number? }

type Prefs = {
	editing: Editing?,
	focus: string?,
	snap: common.Snapshot?, -- the newest snapshot on disk: the rows, the defaults and where settings.json lives
	stored: { [string]: any },
	note: string?,
}

local function settings_file(snap: common.Snapshot): string
	return `{snap.root}/settings.json`
end

local function new_prefs(): Prefs
	local state: Prefs = { snap = common.snapshots(false)[1], stored = {} }
	local snap = state.snap
	if snap and tern.fs.exists(settings_file(snap)) then
		local ok, value = pcall(function()
			return tern.json.decode(tern.fs.read(settings_file(snap)))
		end)
		if ok and type(value) == "table" then
			state.stored = value
		end
	end
	return state
end

-- Writes one setting (nil resets it); running sessions read the file again within a second.
local function store(state: Prefs, key: string, value: string?)
	local snap = state.snap
	if not snap then
		return
	end
	state.stored[key] = value
	local ok, err = pcall(function()
		tern.fs.mkdir(snap.root)
		tern.fs.write(settings_file(snap), tern.json.encode(state.stored, true))
	end)
	state.note = if ok then nil else `Could not save: {err}`
	snap.settings[key] = value or snap.defaults[key]
end

local function prefs_view(state: Prefs): Node
	local snap = state.snap
	if not snap then
		return ui.text(ui.span("Start omp with pi-keepalive in a Tern pane once; its settings appear here.", "muted"))
	end
	local rows = {}
	local changed = 0
	for _, def in snap.rows do
		local value = snap.settings[def.key] or ""
		local default = snap.defaults[def.key] or ""
		local control: { [string]: any }
		if #def.choices > 0 then
			local options = {}
			local present = false
			for _, choice in def.choices do
				table.insert(options, { value = choice, label = choice })
				present = present or choice == value
			end
			if not present and value ~= "" then
				table.insert(options, { value = value, label = value })
			end
			control = { k = "choice", value = value, options = options, style = "auto" }
		else
			control = { k = "text", value = value, placeholder = if default == "" then "Not set" else default, mono = true }
		end
		if value ~= default then
			changed += 1
		end
		table.insert(rows, {
			id = def.key, label = def.title, control = control, changed = value ~= default,
			defaultLabel = if default == "" then "not set" else default,
		})
	end
	return ui.node("prefs", {
		key = "prefs",
		title = "Keepalive",
		pages = { { id = "keepalive", label = "Prompt cache", icon = "database", changed = changed } },
		page = "keepalive",
		lead = state.note
			or `Saved to {settings_file(snap)}; every omp session picks changes up within a second. PI_KEEPALIVE_* variables still win.`,
		focus = state.focus,
		editing = state.editing,
		sections = { { id = "cache", title = "Cache upkeep and TTL", page = "keepalive", rows = rows } },
	})
end

local function row_def(snap: common.Snapshot?, key: string): common.SettingRow?
	if snap then
		for _, def in snap.rows do
			if def.key == key then
				return def
			end
		end
	end
	return nil
end

-- Handles the prefs page's events; `close` runs when the page is closed.
local function prefs_event(state: Prefs, ev: UiEvent, close: () -> ())
	local item = if type(ev.item) == "string" then ev.item else nil
	if ev.ev == "change" and item then
		state.editing = nil
		store(state, item, if type(ev.value) == "string" then ev.value else nil)
	elseif ev.ev == "activate" and item then
		local def = row_def(state.snap, item)
		if def and #def.choices == 0 then
			local draft = (state.snap :: common.Snapshot).settings[item] or ""
			state.editing = { row = item, draft = draft, cursor = utf8.len(draft) or #draft }
		elseif def then
			state.editing = { row = item }
		end
		state.focus = item
	elseif ev.ev == "select" and item and not string.find(item, "=", 1, true) then
		state.focus = item
	elseif ev.ev == "action" and ev.act == "close" then
		if ev.value ~= nil then
			state.editing = nil
		else
			close()
		end
	end
end

-- Keys on the prefs page: text rows are typed into (Backspace, Enter saves, Escape cancels); Escape closes the page.
local function prefs_key(state: Prefs, key: Key, close: () -> ()): boolean?
	local editing = state.editing
	if not editing then
		if key.name == "escape" then
			close()
			return true
		end
		return false
	end
	if editing.draft == nil then
		if key.name == "escape" then
			state.editing = nil
			return true
		end
		return false
	end
	local draft = editing.draft :: string
	if key.name == "escape" then
		state.editing = nil
		return true
	elseif key.name == "enter" then
		state.editing = nil
		store(state, editing.row, if draft == "" then nil else draft)
		return true
	elseif key.name == "backspace" then
		local cut = utf8.offset(draft, -1)
		draft = if cut then string.sub(draft, 1, cut - 1) else ""
	elseif key.text and not key.ctrl and not key.meta then
		draft ..= key.text
	else
		return false
	end
	state.editing = { row = editing.row, draft = draft, cursor = utf8.len(draft) or #draft }
	return true
end

tern.block.define("settings", {
	init = function(_cx: BlockCx, _args: { string }, _saved: any): Prefs
		return new_prefs()
	end,
	view = function(state: Prefs, _cx: BlockCx): BlockView
		return { main = ui.col({ prefs_view(state) }) }
	end,
	title = function(_state: Prefs): string?
		return "Keepalive settings"
	end,
	event = function(state: Prefs, ev: UiEvent, cx: BlockCx)
		prefs_event(state, ev, function()
			cx:exit(0)
		end)
	end,
	key = function(state: Prefs, key: Key, cx: BlockCx): boolean?
		return prefs_key(state, key, function()
			cx:exit(0)
		end)
	end,
})

----------------------------------------------------------------------------------------------------------------------
-- Dashboard

type Dash = {
	pane: number?, -- the omp pane shown; nil follows the newest live one
	filter: string,
	snap: common.Snapshot?,
	raw: string?, -- the snapshot last drawn, so an unchanged one costs no render
	prefs: Prefs?, -- the settings sheet, while open
}

local open: { [number]: { cx: BlockCx, state: Dash, since: number } } = {}

-- Reads the shown pane's snapshot; true when it changed.
local function load(state: Dash): boolean
	local snap = if state.pane then common.snapshot(state.pane) else common.snapshots(true)[1]
	state.snap = snap
	local raw = if snap then tern.json.encode(snap) else ""
	if raw == state.raw then
		return false
	end
	state.raw = raw
	return true
end

-- Spacing scale for the dashboard: sections LG apart, lines within a section SM apart, items within a line MD apart, a
-- label and its own chips XS apart. Every section starts at the same left edge; nothing is indented.
local LG, MD, SM, XS = "lg", "md", "sm", "xs"
local LABEL_W = "9ch" -- the width of a row label (Upkeep, Session), so the controls and bars after it line up

local function label(text: string): Node
	return ui.node("text", { spans = { ui.span(text, "muted") }, min = { w = LABEL_W } })
end

-- A section: a heading over a hairline (status.css `.ka-head`), then its lines.
local function section(key: string, title: string, lines: { Node }): Node
	local body: { Node } = { ui.el("div", { class = "ka-head", text = title }) }
	for _, line in lines do
		table.insert(body, line)
	end
	return ui.node("col", { key = key, gap = SM }, body)
end

-- One hit-rate line: label, rate, a fixed-width bar (status.css `.ka-meter`), then what it covers. Labels, rates and bars
-- have fixed widths, so the Now and Session bars start and end in the same place whatever their details say.
local function rate(name: string, r: common.Rate?): Node
	local known = r ~= nil and r.percent ~= nil
	local percent = if r and r.percent then r.percent else 0
	local detail = "no requests yet"
	if r and known then
		detail = `over {r.requests} request{if r.requests == 1 then "" else "s"}`
		if r.read then
			detail ..= ` · read {common.tokens(r.read)} · write {common.tokens(r.write or 0)} · new {common.tokens(r.fresh or 0)}`
		end
	end
	return ui.node("row", { key = name, gap = MD }, {
		label(name),
		ui.node("text", { spans = { ui.span(if known then `{percent}%` else "n/a", if known then "strong" else "muted") }, min = { w = "5ch" } }),
		ui.el("div", { class = "ka-meter" }, { ui.node("meter", { value = percent / 100, tone = if r and known then common.tone(r.grade) else "muted" }) }),
		ui.node("text", { spans = { ui.span(detail, "muted") } }),
	})
end

local function matrix(cells: { { glyph: string, tone: string } }): Node
	local spans: { Span | string } = {}
	for _, cell in cells do
		table.insert(spans, ui.span(cell.glyph, if cell.tone == "quiet" then "dim" else common.tone(cell.tone)))
	end
	if #spans == 0 then
		return ui.text(ui.span("No requests yet. Each request this session gets a dot here.", "muted"))
	end
	return ui.text(spans)
end

local function wanted(filter: string, r: common.Request): boolean
	return filter == "all" or (filter == "real" and r.kind == "real") or (filter == "keepalives" and r.kind == "keepalive")
		or (filter == "compactions" and r.kind == "compaction") or (filter == "misses" and r.miss ~= nil)
end

local REQUEST_COLS: { Col } = {
	{ id = "request", head = "Request", priority = 3 },
	{ id = "hit", head = "Hit", priority = 4, grow = 1 },
	{ id = "ttl", head = "TTL", priority = 2 },
	{ id = "miss", head = "Miss", priority = 2 },
	{ id = "read", head = "Read", align = "end", priority = 3 },
	{ id = "write", head = "Write", align = "end", priority = 3 },
	{ id = "new", head = "New", align = "end", priority = 1 },
	{ id = "out", head = "Out", align = "end", priority = 0 },
	{ id = "model", head = "Model", priority = 0, truncate = "middle" },
}

local function requests(state: Dash, list: { common.Request }): Node
	local filters: { Node } = {}
	for _, f in common.FILTERS do
		table.insert(filters, chip(f, `filter={f}`, state.filter == f))
	end
	local rows: { { Cell } } = {}
	for _, r in list do
		if wanted(state.filter, r) then
			local hit: Cell = if r.percent then { meter = { value = r.percent / 100, tone = common.tone(r.grade) } } else ui.span("–", "muted")
			local row: { Cell } = {
				ui.span(r.name, if r.kind == "real" then "mono" else "muted"), hit, r.ttl or "–", ui.span(r.miss or "", "warning"),
				common.tokens(r.read), common.tokens(r.write), common.tokens(r.fresh), common.tokens(r.output), ui.span(r.model, "muted"),
			}
			table.insert(rows, row)
		end
	end
	local body = if #rows > 0 then ui.table(REQUEST_COLS, rows) else ui.text(ui.span("No requests match this filter.", "muted"))
	return section("requests", `Recent requests · {#rows}`, {
		ui.node("row", { key = "filters", gap = MD }, { label("Show"), ui.node("row", { gap = XS }, filters) }),
		body,
	})
end

-- The bar as the status line draws it: one span per styled piece of pi-keepalive's `barSpans`, classed `ka-t ka-<tone>`
-- (status.css colours them), `ka-join` for a piece that touches the previous one; then the last request's token counts,
-- faint. A snapshot without spans (an older pi-keepalive) shows its plain text.
local function styled_bar(bar: common.Bar, counts: string?): Node
	local spans = bar.spans
	if not spans or #spans == 0 then
		return ui.text(ui.span(bar.text, "mono"))
	end
	local pieces: { Node } = {}
	for _, span in spans do
		table.insert(pieces, ui.el("span", { class = `ka-t ka-{span.tone}{if span.join then " ka-join" else ""}`, text = span.text }))
	end
	if counts then
		table.insert(pieces, ui.el("span", { class = "ka-t ka-sep", text = "·" }))
		table.insert(pieces, ui.el("span", { class = "ka-t ka-counts", text = counts }))
	end
	return ui.el("div", { class = "ka-bar" }, pieces)
end

local function dashboard_main(state: Dash): Node
	local snap = state.snap
	if not snap or not snap.bar or not snap.dashboard then
		local why = if snap and not snap.enabled then "Keepalive is off in this session (/keepalive on)."
			elseif state.pane then `No omp session with pi-keepalive is publishing for pane {state.pane}.`
			else "No omp session with pi-keepalive is publishing in Tern."
		return ui.node("col", { gap = MD }, { ui.text(ui.span(why, "muted")), ui.node("row", {}, { chip("Settings", "settings", false) }) })
	end
	local bar = snap.bar :: common.Bar
	local d = snap.dashboard :: common.Dashboard
	local counts = string.match(bar.text, " · (read .*)$")

	-- Controls: the mode chips, then the TTL chips, then Settings pushed to the far right.
	local modes: { Node } = {}
	for _, mode in common.UPKEEP do
		-- The current mode's chip takes that mode's colour (status.css), as its diamonds do.
		table.insert(modes, with(chip(mode, `upkeep={mode}`, bar.upkeep == mode), { role = `keepalive.mode.{mode}` }))
	end
	local controls: { Node } = { label("Upkeep"), ui.node("row", { gap = XS }, modes) }
	if bar.ttl then
		table.insert(controls, ui.node("text", { spans = { ui.span("TTL", "muted") } }))
		table.insert(controls, ui.node("row", { gap = XS }, { chip("5m", "ttl=5m", bar.ttl == "5m"), chip("1h", "ttl=1h", bar.ttl == "1h") }))
	end
	table.insert(controls, ui.node("row", { grow = 1 }))
	table.insert(controls, chip("Settings", "settings", false))

	-- Overview: the bar as in the status line, then its controls.
	local overview = ui.node("col", { key = "overview", gap = MD }, {
		with(styled_bar(bar, counts), { key = "bar" }),
		ui.node("row", { key = "controls", gap = MD }, controls),
	})

	-- Hit rate: now and over the session, one dot per request, recent misses.
	local hits: { Node } = { rate("Now", d.recent), rate("Session", d.session), with(matrix(d.cells), { key = "matrix" }) }
	if d.misses then
		table.insert(hits, ui.text(ui.span(d.misses, "warning")))
	end

	-- Cache: the conversation's lifetime, upkeep and totals. Its first line repeats the bar above and is left out.
	local cache: { Node } = {}
	if not bar.available then
		table.insert(cache, ui.text(ui.span("Storage unavailable · showing last known observations", "warning")))
	end
	for i, line in d.main do
		if i > 1 then
			table.insert(cache, ui.text(ui.span(line, "muted")))
		end
	end
	table.insert(cache, ui.text(ui.span(`Upkeep: {d.upkeep}`, "muted")))

	return ui.node("col", { gap = LG }, {
		overview,
		section("hits", "Hit rate", hits),
		section("cache", "Cache", cache),
		requests(state, d.requests),
		with(ui.text(ui.span(d.legend, "dim")), { key = "legend" }),
	})
end

tern.block.define("dashboard", {
	init = function(cx: BlockCx, args: { string }, saved: any): Dash
		local was = if type(saved) == "table" then saved else {}
		local state: Dash = { pane = tonumber(args[1] or was.pane), filter = if type(was.filter) == "string" then was.filter else "all" }
		load(state)
		if state.snap and not state.pane then
			state.pane = tonumber(state.snap.pane)
		end
		open[cx.pane] = { cx = cx, state = state, since = tern.now() }
		return state
	end,
	view = function(state: Dash, _cx: BlockCx): BlockView
		return { main = dashboard_main(state), layer = if state.prefs then ui.col({ prefs_view(state.prefs) }) else nil }
	end,
	title = function(state: Dash): string?
		return if state.pane then `Keepalive · pane {state.pane}` else "Keepalive"
	end,
	event = function(state: Dash, ev: UiEvent, _cx: BlockCx)
		local prefs = state.prefs
		local close = function()
			state.prefs = nil
		end
		if prefs and (ev.ev ~= "action" or ev.act == "close" or ev.act == "page") then
			prefs_event(prefs, ev, close)
		elseif ev.ev ~= "action" then
			return
		elseif ev.act == "filter" and type(ev.value) == "string" then
			state.filter = ev.value
		elseif ev.act == "settings" then
			state.prefs = new_prefs()
		elseif state.pane and (ev.act == "upkeep" or ev.act == "ttl") and type(ev.value) == "string" then
			common.command(state.pane, { upkeep = if ev.act == "upkeep" then ev.value else nil, ttl = if ev.act == "ttl" then ev.value else nil })
		end
	end,
	key = function(state: Dash, key: Key, _cx: BlockCx): boolean?
		local prefs = state.prefs
		if not prefs then
			return false
		end
		return prefs_key(prefs, key, function()
			state.prefs = nil
		end)
	end,
	save = function(state: Dash): any
		return { pane = state.pane, filter = state.filter }
	end,
})

----------------------------------------------------------------------------------------------------------------------
-- The clock: once a second, re-read the snapshots the dashboards show and redraw those that changed; every
-- HEARTBEAT_EVERY seconds, the heartbeat; every SWEEP_EVERY, the files of panes that closed.

local SWEEP_EVERY = 60

-- Drops dashboards whose pane is gone (a block registers in `init`, which can run before the daemon lists its pane, so
-- young ones stay); with `sweep`, the snapshot and command files of closed panes, all but the newest snapshot, which the
-- settings page reads while no omp runs.
local function prune(sweep: boolean)
	local live: { [number]: boolean } = {}
	for _, info in tern.pane.list() do
		live[info.pane] = true
	end
	for pane, entry in open do
		if not live[pane] and tern.now() - entry.since > 2000 then
			open[pane] = nil
		end
	end
	if not sweep then
		return
	end
	for i, snap in common.snapshots(false) do
		local pane = tonumber(snap.pane)
		if i > 1 and pane and not live[pane] and snap.at / 1000 < os.time() - common.STALE_S then
			pcall(tern.fs.remove, common.pane_file(pane))
			pcall(tern.fs.remove, `{tern.plugin.data}/control/{pane}.json`)
		end
	end
end

local beats = 0
local function tick()
	-- Re-armed first, so one failing pass doesn't stop the clock.
	tern.timer(1000, tick)
	if beats % HEARTBEAT_EVERY == 0 then
		heartbeat()
	end
	beats += 1
	prune(beats % SWEEP_EVERY == 1)
	for _, entry in open do
		local ok, err = pcall(function()
			if load(entry.state) then
				entry.cx:render()
			end
		end)
		if not ok then
			tern.log.warn("keepalive dashboard refresh failed", err)
		end
	end
end
tick()
