#!/bin/bash
# Usage: e2e/run.sh [--mount DIR:/ctr/path ...] [--env K=V ...] -- <command...>   (default command: bash)
# Builds image if missing; runs with key from ~/.cvm/profiles/gateway.env via a temp 0600 env-file.
# All container output is redacted. Never prints the key.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${PROFILE_ENV:-$HOME/.cvm/profiles/gateway.env}"
IMAGE=pi-keepalive-e2e
MOUNTS=(); 
while [ $# -gt 0 ]; do case "$1" in --mount) MOUNTS+=(-v "$2"); shift 2;; --env) MOUNTS+=(-e "$2"); shift 2;; --) shift; break;; *) break;; esac; done
docker image inspect $IMAGE >/dev/null 2>&1 || docker build -q -t $IMAGE "$HERE" >/dev/null || exit 1
ENVF="$(mktemp)"; chmod 600 "$ENVF"; trap 'rm -f "$ENVF"' EXIT
KEY=""
for n in ANTHROPIC_BASE_URL ANTHROPIC_API_KEY; do
  v="$(grep -E "^(export )?$n=" "$PROFILE" | tail -1 | sed -E "s/^(export )?$n=//; s/^[\"']//; s/[\"'][[:space:]]*\$//")"
  [ -n "$v" ] || { echo "missing $n in profile" >&2; exit 1; }
  printf '%s=%s\n' "$n" "$v" >> "$ENVF"
  [ "$n" = ANTHROPIC_API_KEY ] && KEY="$v"
done
[ $# -gt 0 ] || set -- bash
# Redact exact key value (escaped for sed), sk-* tokens, Bearer tokens, x-api-key values.
ESC="$(printf '%s' "$KEY" | sed -e 's/[]\/$*.^[|&]/\\&/g')"
redact() { sed -u -E -e "s/${ESC}/[REDACTED]/g" -e 's/sk-[A-Za-z0-9_-]{8,}/[REDACTED]/g' -e 's/(Bearer )[A-Za-z0-9._~+\/=-]{8,}/\1[REDACTED]/g' -e 's/(x-api-key"?[:=] *"?)[A-Za-z0-9._-]{8,}/\1[REDACTED]/gI'; }
docker run --rm -i --env-file "$ENVF" ${MOUNTS[@]+"${MOUNTS[@]}"} $IMAGE "$@" 2>&1 | redact
exit ${PIPESTATUS[0]}
