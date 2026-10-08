#!/bin/bash
# Runs inside the container: one real session (RPC) with the extension loaded, an idle gap in which a keepalive must fire,
# then a second real turn. usage: in-container.sh pi|omp   (extension mounted at /ext, trace to /tmp/trace.jsonl)
set -u
TOOL=$1
export PI_KEEPALIVE_E2E=1 PI_KEEPALIVE_E2E_TTL_MS=${E2E_TTL_MS:-20000} PI_KEEPALIVE_UPKEEP=warm PI_KEEPALIVE_LIMIT=2
export PI_KEEPALIVE_DIR=/tmp/ka-data PI_KEEPALIVE_TRACE=/tmp/trace.jsonl PI_KEEPALIVE_THEME=dark
rm -rf /tmp/ka-data /tmp/trace.jsonl; mkdir -p /tmp/ka-data
# ~5k tokens of stable, cacheable text
DOC=$(node -e '
const words="alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");
let o="run "+Date.now()+" "+Math.random()+".\n";for(let i=0;i<3600;i++)o+=words[(i*7+3)%26]+(i%12==11?".\n":" ");process.stdout.write(o)')
P1=$(jq -cn --arg d "$DOC" '{id:"p1",type:"prompt",message:("Here is a reference document. Do not use tools.\n\n"+$d+"\n\nReply with only: A")}')
P2='{"id":"p2","type":"prompt","message":"Reply with only: B"}'
GAP=${E2E_GAP_S:-50}
{ echo "$P1"; sleep "$GAP"; echo "$P2"; sleep 20; } \
 | $TOOL --mode rpc --no-session -e /ext/index.ts > /tmp/rpc.out 2>/tmp/rpc.err
echo "== rpc exit $? =="
echo "== trace =="; cat /tmp/trace.jsonl 2>/dev/null | cut -c1-700
echo "== assistant usage (message_end) =="
grep -o '"type":"message_end".\{0,0\}' /tmp/rpc.out | wc -l
jq -c 'select(.type=="message_end" and .message.role=="assistant") | {usage:.message.usage, stop:.message.stopReason, text:(.message.content|map(.text?)|join(""))[0:40]}' /tmp/rpc.out 2>/dev/null | cut -c1-300
echo "== stderr =="; head -c 1500 /tmp/rpc.err
