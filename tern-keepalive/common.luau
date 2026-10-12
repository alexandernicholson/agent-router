--!strict
-- keepalive, shared by both halves: reading the snapshots pi-keepalive publishes for each omp pane, writing the
-- commands it takes back, and the small formatting helpers the bar and the dashboard share.
--
-- The contract with pi-keepalive (pi-keepalive/lib/tern.ts), all under tern.plugin.data:
--   panes/<pane>.json    the pane's snapshot, rewritten by the extension at least every 5 s while it runs
--   control/<pane>.json  {seq, queue = [{seq, upkeep?, ttl?}, …]}: the pane's last commands; the extension applies each
--                        one whose seq is newer than the last it applied, in order
--   active.json          {at = unix seconds}: this plugin's heartbeat; while it is fresh the extension hides its own bar

local M = {}

M.SNAPSHOT_VERSION = 1
-- A snapshot older than this belongs to an omp that exited or hung.
M.STALE_S = 30
M.UPKEEP = { "off", "warm", "compact", "warmcomp" }
M.FILTERS = { "all", "real", "keepalives", "compactions", "misses" }

-- One styled piece of the bar (pi-keepalive's `barSpans`): `tone` names its colour in status.css, `join` puts it flush
-- against the previous piece.
export type BarSpan = { text: string, tone: string, join: boolean? }

export type Bar = {
	text: string,
	spans: { BarSpan }?,
	dial: string,
	upkeep: string,
	ttl: string?,
	percent: number?,
	grade: string?,
	leftMs: number?,
	life: string?,
	misses: number,
	available: boolean,
}

-- The bar as status segments, one per styled piece. Each tone is `ka <tone>` (plus ` join`), a value no Tern style
-- claims, so status.css colours it alone through `[data-tone~=…]`. A snapshot from a pi-keepalive without spans gets one
-- plain segment, without the token counts.
function M.segments(bar: Bar, command: string): { StatusSegment }
	local spans = bar.spans
	if not spans or #spans == 0 then
		local text = string.gsub(bar.text, " · read .*$", "")
		return { { text = text, icon = "database", tone = if bar.life then M.tone(bar.life) else "muted", command = command } }
	end
	local out: { StatusSegment } = {}
	for _, span in spans do
		table.insert(out, { text = span.text, tone = `ka {span.tone}{if span.join then " join" else ""}`, command = command })
	end
	return out
end

export type Request = {
	name: string,
	kind: string,
	percent: number?,
	grade: string?,
	ttl: string?,
	miss: string?,
	read: number,
	write: number,
	fresh: number,
	output: number,
	model: string,
	startedAt: number,
}

export type Rate = { percent: number?, grade: string?, requests: number, read: number?, write: number?, fresh: number? }

export type Dashboard = {
	recent: Rate?,
	session: Rate?,
	cells: { { glyph: string, tone: string } },
	misses: string?,
	upkeep: string,
	legend: string,
	main: { string },
	requests: { Request },
}

export type SettingRow = { key: string, title: string, choices: { string } }

export type Snapshot = {
	v: number,
	version: string,
	pane: string,
	session: string,
	cwd: string?,
	root: string,
	at: number,
	enabled: boolean,
	settings: { [string]: string },
	defaults: { [string]: string },
	rows: { SettingRow },
	bar: Bar?,
	dashboard: Dashboard?,
}

local function read_json(path: string): any
	if not tern.fs.exists(path) then
		return nil
	end
	local ok, value = pcall(function()
		return tern.json.decode(tern.fs.read(path))
	end)
	return if ok then value else nil
end

local function valid(value: any): boolean
	return type(value) == "table" and value.v == M.SNAPSHOT_VERSION and type(value.at) == "number"
		and type(value.root) == "string" and type(value.rows) == "table" and type(value.settings) == "table"
end

function M.pane_file(pane: number | string): string
	return `{tern.plugin.data}/panes/{pane}.json`
end

-- The pane's snapshot while its omp is alive; nil when there is none, it is malformed or stale.
function M.snapshot(pane: number | string): Snapshot?
	local value = read_json(M.pane_file(pane))
	if not valid(value) or value.at / 1000 < os.time() - M.STALE_S then
		return nil
	end
	return value :: Snapshot
end

-- Every pane snapshot on disk, newest first; `live` keeps only fresh ones.
function M.snapshots(live: boolean): { Snapshot }
	local dir = `{tern.plugin.data}/panes`
	local out: { Snapshot } = {}
	if not tern.fs.exists(dir) then
		return out
	end
	for _, name in tern.fs.list(dir) do
		local pane = string.match(name, "^(%d+)%.json$")
		if pane then
			local value = if live then M.snapshot(pane) else read_json(`{dir}/{name}`)
			if valid(value) then
				table.insert(out, value :: Snapshot)
			end
		end
	end
	table.sort(out, function(a, b)
		return a.at > b.at
	end)
	return out
end

-- Commands kept in a pane's queue: enough for a burst of clicks between two of the extension's one-second polls.
local QUEUE = 16

-- Queues a command for the pane's extension, which applies it within a second.
function M.command(pane: number | string, fields: { upkeep: string?, ttl: string? })
	local dir = `{tern.plugin.data}/control`
	local file = `{dir}/{pane}.json`
	local last = read_json(file)
	local seq = if type(last) == "table" and type(last.seq) == "number" then last.seq + 1 else 1
	local queue = if type(last) == "table" and type(last.queue) == "table" then last.queue else {}
	table.insert(queue, { seq = seq, upkeep = fields.upkeep, ttl = fields.ttl })
	while #queue > QUEUE do
		table.remove(queue, 1)
	end
	tern.fs.mkdir(dir)
	tern.fs.write(file, tern.json.encode({ seq = seq, queue = tern.json.array(queue) }))
end

-- A cache grade (good/fair/poor, or quiet for the matrix) as a theme tone.
function M.tone(grade: string?): string
	if grade == "good" then
		return "success"
	elseif grade == "fair" then
		return "warning"
	elseif grade == "poor" then
		return "error"
	end
	return "muted"
end

-- Token counts as pi-keepalive writes them: 950, 1.2k, 3.4m.
function M.tokens(value: number): string
	if value < 1000 then
		return tostring(value)
	end
	local scaled = if value >= 1e6 then value / 1e6 else value / 1000
	local text = string.format("%.1f", scaled)
	text = string.gsub(text, "%.0$", "")
	return text .. (if value >= 1e6 then "m" else "k")
end

return M
