# Changelog

Each release explains what changed for you, in 120 words or less.

## 0.16.2

- **No vanishing countdowns on gateway models.** Some gateway models never report how long their cache lasts. Their bar now says `TTL not reported` from the start instead of counting down for 30 seconds and then switching.
- **A brief gateway hiccup no longer turns routing off.** If the model list check at session start gets a server error, Agent Router tries twice more before giving up.

## 0.16.1

- **Teammates keep their models.** A teammate started with a role now runs on the teammate model, and on the teammate TTL, as set in `/agent-models` → Teammates.
- **Split-pane teammates show their cache.** Their bar and the lead's dashboard now fill in from the first request, and each teammate appears once.
- **Teammate keepalives hit the cache.** A split-pane teammate whose role sets an effort sends keepalives and compactions at that effort, so they reuse its cache instead of rewriting it.
- **A tidier miss chip.** `✕` now has a space after it.

## 0.16.0

- **Choose how many keepalives to send.** `/agent-models` → Prompt cache has a keepalive limit: `default` warms while it costs less than rewriting the cache, a number sends exactly that many, and `infinite` warms until you're back.
- **A steadier hit rate.** The bar shows the hit rate over your last 10 requests.
- **Misses you won't miss.** A small `✕ 2 prefix` chip shows cache misses from the last 15 minutes and their causes. It dims after 5 minutes; click it for details.
- **No more "TTL not reported" flicker.** A new cache counts down from your chosen TTL until the actual one arrives.
- **Each request's TTL** now shows in the dashboard's history.

## 0.15.0

- **Choose each conversation's cache lifetime.** Click `TTL 5m` on the cache bar to switch that conversation between 5 minutes and 1 hour. Subagents and teammates keep their own setting. Defaults for each are in `/agent-models`, and show exactly what Claude Code would use.
- **Accurate Claude prices.** Keepalive costs now use Anthropic's published prices, including 1-hour caches, whatever your gateway calls the model.
- **A quick guide.** The first time the cache bar appears, a short guide explains it. It shows once and is never sent to the model.
