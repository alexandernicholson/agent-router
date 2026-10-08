#!/bin/bash
# usage (inside container): rpc-probe.sh pi|omp EXT_PATH [IDLE_SECONDS]
# Sends 1 prompt over RPC, idles, then asks for session stats; keeps process alive across the idle gap.
TOOL=$1; EXT=$2; IDLE=${3:-10}
{ echo '{"id":"p1","type":"prompt","message":"Reply with only: OK"}'; sleep "$IDLE"; echo '{"id":"s1","type":"get_session_stats"}'; sleep 3; } \
 | $TOOL --mode rpc --no-session -e "$EXT" 2>&1 | grep -E '"(response|agent_settled|prompt_result)"|\[probe\]|rror' | cut -c1-400
