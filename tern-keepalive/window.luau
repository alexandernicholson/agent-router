--!strict
-- keepalive, window half: the prompt-cache bar of the focused omp pane in Tern's status line, and the palette
-- commands that open the dashboard and settings and change the pane's upkeep and TTL.

local common = require("./common")

local DASHBOARD = "keepalive.dashboard"
local SETTINGS = "keepalive.settings"
local OPEN_DASHBOARD = "plugin.keepalive.dashboard"

-- The focused pane and the status segments drawn for it (empty: not an omp pane running pi-keepalive).
local focused: number? = nil
local segments: { StatusSegment } = {}
local bar: common.Bar? = nil

-- What the segments look like, to redraw the status line only when it changed.
local function key(list: { StatusSegment }): string
	local parts = {}
	for _, s in list do
		table.insert(parts, `{s.tone or ""}\t{s.text}`)
	end
	return table.concat(parts, "\n")
end

-- Re-reads the focused pane's snapshot; redraws the status line when its segments changed.
local function refresh(cx: WindowCx)
	focused = cx.session:focused()
	local snap = if focused then common.snapshot(focused :: number) else nil
	bar = if snap and snap.enabled then snap.bar else nil
	local next = if bar then common.segments(bar :: common.Bar, OPEN_DASHBOARD) else {}
	local changed = key(next) ~= key(segments)
	segments = next
	if changed then
		tern.chrome.refresh()
	end
end

local function tick(cx: WindowCx?)
	tern.timer(1000, tick)
	if cx then
		refresh(cx)
	end
end

tern.on("window_start", function(cx: WindowCx)
	refresh(cx)
end)

tern.on("focus", function(_ev: FocusEvent, cx: WindowCx)
	refresh(cx)
end)

tern.timer(0, tick)

tern.chrome.status(function(pane: StatusPaneInfo): { StatusSegment }?
	if pane.pane ~= focused or #segments == 0 then
		return nil
	end
	return segments
end)

-- Focuses a pane of this window whose title starts with `title`; true when there was one.
local function focus_titled(cx: WindowCx, title: string): boolean
	for _, pane in cx.session:panes() do
		if string.sub(pane.title, 1, #title) == title then
			cx.layout:focus(pane.pane)
			return true
		end
	end
	return false
end

local function unavailable(cx: WindowCx)
	cx:toast("error", "Keepalive is unavailable", "The keepalive host half isn't loaded on this host.")
end

tern.command({
	id = "dashboard",
	title = "Open prompt-cache dashboard",
	icon = "database",
	run = function(cx: WindowCx)
		refresh(cx)
		local pane = if bar then focused else nil
		if pane and focus_titled(cx, `Keepalive · pane {pane}`) then
			return
		end
		if cx:new_block(DASHBOARD, if pane then { tostring(pane) } else nil, "split") == nil then
			unavailable(cx)
		end
	end,
})

tern.command({
	id = "settings",
	title = "Keepalive settings",
	icon = "sliders",
	run = function(cx: WindowCx)
		if not focus_titled(cx, "Keepalive settings") and cx:new_block(SETTINGS, nil, "tab") == nil then
			unavailable(cx)
		end
	end,
})

-- Commands for the focused omp pane; they show only while it publishes a bar.
local function pane_command(id: string, title: string, icon: string, fields: { upkeep: string?, ttl: string? }, toast: string)
	tern.command({
		id = id,
		title = title,
		icon = icon,
		available = function(_cx: WindowCx): boolean
			return bar ~= nil and (fields.ttl == nil or (bar :: common.Bar).ttl ~= nil)
		end,
		run = function(cx: WindowCx)
			if not focused or not bar then
				return
			end
			local pane = focused :: number
			local ok, err = pcall(function()
				common.command(pane, fields)
			end)
			if ok then
				cx:toast("info", toast)
			else
				cx:toast("error", "Keepalive command failed", tostring(err))
			end
		end,
	})
end

pane_command("upkeep-cycle", "Cycle prompt-cache upkeep", "redo", { upkeep = "cycle" }, "Keepalive upkeep: next mode")
for _, mode in common.UPKEEP do
	pane_command(`upkeep-{mode}`, `Prompt-cache upkeep: {mode}`, "database", { upkeep = mode }, `Keepalive upkeep: {mode}`)
end
pane_command("ttl-toggle", "Toggle prompt-cache TTL (5m / 1h)", "clock", { ttl = "toggle" }, "Keepalive TTL toggled")
