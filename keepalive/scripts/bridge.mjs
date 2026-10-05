#!/usr/bin/env node
import { handleRequest } from '../lib/bridge.mjs';
import { runBridge } from '../lib/shared/bridge-main.mjs';

await runBridge(import.meta.url, handleRequest, { label: 'Keepalive', withoutData: ['identity'], withTeammate: ['identity'] });
