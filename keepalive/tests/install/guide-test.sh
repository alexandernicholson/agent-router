#!/bin/sh
# Follows keepalive/INSTALL.md literally on a fresh Ubuntu user.
set -u
pass() { echo "PASS $1"; }; fail() { echo "FAIL $1"; }
cd /tmp
[ "$(claude --version | cut -d' ' -f1 | awk -F. '{print ($1*1000000+$2*1000+$3 >= 2001289)}')" = 1 ] && pass "claude >= 2.1.289" || fail "claude version"
node --version | grep -qE '^v(2[2-9]|[3-9][0-9])' && pass "node >= 22" || fail "node version"
git --version >/dev/null && pass "git present" || fail "git"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
# §2
claude plugin marketplace add alexandernicholson/agent-router >/dev/null 2>&1 && pass "§2 marketplace add" || fail "§2 marketplace add"
claude plugin install keepalive@agent-router-tools >/dev/null 2>&1 && pass "§2 install" || fail "§2 install"
claude plugin list 2>/dev/null | grep -q "keepalive@agent-router-tools" && pass "§2 listed" || fail "§2 listed"
# §3
claude plugin install keepalive@agent-router-tools --config cache_upkeep=warm >/dev/null 2>&1
grep -q '"cache_upkeep": *"warm"' ~/.claude/settings.json && pass "§3 --config cache_upkeep=warm" || fail "§3 config"
# §6 a few settings via --config
claude plugin install keepalive@agent-router-tools --config unreported_ttl=15m --config compact_threshold=60k >/dev/null 2>&1
grep -q '"unreported_ttl": *"15m"' ~/.claude/settings.json && grep -q '"compact_threshold": *"60k"' ~/.claude/settings.json && pass "§6 settings via --config" || fail "§6 settings"
# §7
claude plugin marketplace update agent-router-tools >/dev/null 2>&1 && pass "§7 marketplace update" || fail "§7 marketplace update"
claude plugin update keepalive@agent-router-tools >/dev/null 2>&1 && pass "§7 plugin update" || fail "§7 plugin update"
claude plugin list 2>/dev/null | grep -A1 "keepalive@" | grep -q "Version" && pass "§7 version shown" || fail "§7 version"
# §4/§5: interactive bar and /keepalive dashboard (first-run prompts pre-accepted as a user would)
python3 - <<'PY'
import json, os
p=os.path.expanduser("~/.claude.json"); d=json.load(open(p)) if os.path.exists(p) else {}
k=os.environ["ANTHROPIC_API_KEY"]
d.update({"hasCompletedOnboarding":True,"theme":"dark","customApiKeyResponses":{"approved":[k[-20:]],"rejected":[]},"projects":{"/tmp":{"hasTrustDialogAccepted":True,"hasCompletedProjectOnboarding":True}}})
json.dump(d,open(p,"w"))
PY
python3 /w/interactive-test.py > /tmp/ui.txt 2>&1
grep -q "⬥ warm TTL 5m" /tmp/screen.txt && pass "§4 cache bar shown" || fail "§4 cache bar"
grep -q "warm" /tmp/screen.txt && pass "§3 upkeep mode on bar" || fail "§3 upkeep on bar"
grep -q "Prompt cache · all agents" /tmp/screen.txt && pass "§5 /keepalive dashboard" || fail "§5 dashboard"
grep -q "Lifetime icons" /tmp/screen.txt && pass "§4 lifetime icon guide shown" || fail "§4 icon guide"
