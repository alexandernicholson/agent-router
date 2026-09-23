// Split-pane teammates are separate Claude processes. The launch flags are
// the only identity they carry, so the bridge reads them from its ancestors
// and confirms them against the team config Claude Code writes before launch.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const FLAGS = { '--agent-id': 'agentId', '--agent-name': 'agentName', '--team-name': 'teamName',
  '--parent-session-id': 'parentSessionId', '--agent-type': 'agentType' };

export function parseTeammateArgs(argv) {
  const found = {};
  for (let index = 0; index < argv.length; index++) {
    const [flag, inline] = argv[index].split(/=(.*)/s);
    const key = FLAGS[flag];
    if (!key) continue;
    const value = inline !== undefined ? inline : argv[++index];
    if (typeof value === 'string' && value) found[key] = value;
  }
  if (!found.agentId || !found.teamName || !found.parentSessionId) return null;
  return found;
}

// macOS and Linux `ps` report a process's argv joined by spaces; flag values
// Claude Code writes here never contain spaces (ids, names, team, type).
export function readTeammateIdentity(pid = process.ppid, run = execFileSync) {
  for (let depth = 0; depth < 4 && pid > 1; depth++) {
    let line;
    try { line = run('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8' }).trim(); }
    catch { return null; }
    const match = line.match(/^(\d+)\s+(.*)$/s);
    if (!match) return null;
    const identity = parseTeammateArgs(match[2].split(/\s+/));
    if (identity) return identity;
    pid = Number(match[1]);
  }
  return null;
}

export function teamMember(identity, env = process.env) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(identity.teamName)) return null;
  const root = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let config;
  try { config = JSON.parse(readFileSync(join(root, 'teams', identity.teamName, 'config.json'), 'utf8')); }
  catch { return null; }
  if (!Array.isArray(config?.members)) return null;
  const member = config.members.find(item => item?.agentId === identity.agentId);
  if (!member || member.agentType === 'team-lead') return null;
  if ((member.agentType ?? undefined) !== (identity.agentType ?? undefined)) return null;
  // A resumed lead keeps the team it started with, recorded under that first
  // session's id, while its teammates' launch flag names the resumed session.
  return { member, leadConfirmed: config.leadSessionId === identity.parentSessionId };
}
