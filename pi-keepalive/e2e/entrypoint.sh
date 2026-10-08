#!/bin/bash
# Generates Pi + OMP config from env vars at container start (nothing baked in).
set -e
: "${ANTHROPIC_BASE_URL:?}" "${ANTHROPIC_API_KEY:?}"
MODEL="${E2E_MODEL:-claude-sonnet-5-5}"
mkdir -p ~/.pi/agent ~/.omp/agent
umask 077
# Pi: key referenced via env interpolation, not written to disk.
jq -n --arg ttl "${E2E_PROMPT_CACHE_S:-300}" --arg url "${E2E_PI_BASE_URL:-$ANTHROPIC_BASE_URL}" --arg m "$MODEL" '{providers:{anthropic:{
  baseUrl:$url, apiKey:"$ANTHROPIC_API_KEY", api:"anthropic-messages",
  models:[{id:$m,name:"Claude Sonnet 5.5 (e2e)",reasoning:false,input:["text"],
    contextWindow:200000,maxTokens:16000,cost:{input:3,output:15,cacheRead:0.3,cacheWrite:3.75},
    promptCache:{short:($ttl|tonumber)}}]}}}' > ~/.pi/agent/models.json
echo '{"cacheWarming":"'"${E2E_CACHE_WARMING:-off}"'","defaultProvider":"anthropic","defaultModel":"'"$MODEL"'","quietStartup":true}' > ~/.pi/agent/settings.json
# OMP: custom provider "gateway" (key by env-var name, not literal).
cat > ~/.omp/agent/models.yml <<YML
providers:
  gateway:
    baseUrl: ${E2E_OMP_BASE_URL:-$ANTHROPIC_BASE_URL}
    api: anthropic-messages
    apiKey: ANTHROPIC_API_KEY
    models:
      - id: ${MODEL}
        name: Claude Sonnet 5.5 (e2e)
        contextWindow: 200000
        maxTokens: 16000
YML
printf 'modelRoles:\n  default: gateway/%s\n' "$MODEL" > ~/.omp/agent/config.yml
export PI_OFFLINE=1 PI_TELEMETRY=0
exec "$@"
