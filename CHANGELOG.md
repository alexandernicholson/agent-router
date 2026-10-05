# Changelog

Each release explains what changed for you, in 120 words or less.

## 0.15.0

- **Choose each conversation's cache lifetime.** Click `TTL 5m` on the cache bar to switch that conversation between 5 minutes and 1 hour. Subagents and teammates keep their own setting. Defaults for each are in `/agent-models`, and show exactly what Claude Code would use.
- **Accurate Claude prices.** Keepalive costs now use Anthropic's published prices, including 1-hour caches, whatever your gateway calls the model.
- **A quick guide.** The first time the cache bar appears, a short guide explains it. It shows once and is never sent to the model.
