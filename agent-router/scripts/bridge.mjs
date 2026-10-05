#!/usr/bin/env node
import { handleRequest } from '../lib/bridge.mjs';
import { runBridge } from '../lib/shared/bridge-main.mjs';

await runBridge(import.meta.url, (input, env) => handleRequest(input, env), { label: 'Agent Router', withoutData: ['catalog'] });
