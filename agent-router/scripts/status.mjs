#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { routingStatus, stateDirectory } from '../lib/state.mjs';

let options;
try {
  options = parseArgs({
    options: {
      data: { type: 'string' },
      session: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  }).values;
  if (options.session !== undefined && (!options.session || options.session.length > 512)) throw new Error();
} catch {
  process.stderr.write('Usage: node status.mjs [--data PATH] [--session ID] [--json]\n');
  process.exitCode = 1;
}

if (options && !process.exitCode) {
  try {
    const root = stateDirectory(options.data === undefined ? process.env : { CLAUDE_PLUGIN_DATA: options.data });
    const status = await routingStatus(root, options.session);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      // JSON quoting makes identifiers safe to display even if they contain terminal controls.
      const label = value => value === undefined || value === null ? 'not recorded' : JSON.stringify(value);
      const lines = ['Agent Router routing status', 'Observed models and token counts are completed-turn evidence, not upstream model or billing proof.'];
      for (const session of status.sessions) {
        lines.push(`Session ${label(session.sessionId)}: mode=${label(session.mode)}, policy=${label(session.policyDigest)}`);
        if (session.error) lines.push(`  Error: ${label(session.error)}`);
      }
      for (const route of status.routes) {
        lines.push(
          `Route ${label(route.toolUseId ?? route.agentId)}: session=${label(route.sessionId)}, state=${label(route.state)}`,
          `  Requested: type=${label(route.requestedType)}, model=${label(route.requestedModel)}`,
          `  Effective: role=${label(route.role)}, type=${label(route.effectiveType)}, model=${label(route.effectiveModel)}`,
          `  Resolved: model=${label(route.resolvedModel)}, mismatch=${label(route.resolutionMismatch)}`,
          `  Completed turns: count=${label(route.completedTurns)}, models=${label(route.responseModels)}, usage=${label(route.usage)}`,
        );
        if (route.observationError) lines.push(`  Observation error: ${label(route.observationError)}`);
      }
      if (!status.sessions.length && !status.routes.length) lines.push('No routing records found.');
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  } catch {
    process.stderr.write('Unable to read routing status; set CLAUDE_PLUGIN_DATA or --data PATH and check the routing records and permissions.\n');
    process.exitCode = 1;
  }
}
