#!/bin/bash
set -euo pipefail

BASE_URL="${PROXY_BASE_URL:-http://127.0.0.1:4141}"
AUTH_TOKEN="${PROXY_AUTH_TOKEN:-dummy-local-token}"
MODEL="${PROXY_MODEL:-sonnet}"
PROJECT_SLUG="${CLAUDE_PROJECT_SLUG:--Users-concefly-Project-codex}"
PROJECT_DIR="/Users/concefly/.claude/projects/${PROJECT_SLUG}"

ANTHROPIC_BASE_URL="$BASE_URL" \
ANTHROPIC_AUTH_TOKEN="$AUTH_TOKEN" \
ANTHROPIC_MODEL="$MODEL" \
claude -p "Reply with exactly OK" >/tmp/codex-proxy-turn1.txt

if [[ "$(cat /tmp/codex-proxy-turn1.txt)" != "OK" ]]; then
  echo "turn1 failed: $(cat /tmp/codex-proxy-turn1.txt)" >&2
  exit 1
fi

SESSION_ID="$(find "$PROJECT_DIR" -maxdepth 1 -name '*.jsonl' -type f -print0 | xargs -0 ls -t | head -n 1 | xargs basename | sed 's/\.jsonl$//')"

ANTHROPIC_BASE_URL="$BASE_URL" \
ANTHROPIC_AUTH_TOKEN="$AUTH_TOKEN" \
ANTHROPIC_MODEL="$MODEL" \
claude -p -r "$SESSION_ID" "What exact token did I ask you to output previously? Reply only with that token." >/tmp/codex-proxy-turn2.txt

if [[ "$(cat /tmp/codex-proxy-turn2.txt)" != "OK" ]]; then
  echo "turn2 failed: $(cat /tmp/codex-proxy-turn2.txt)" >&2
  exit 1
fi

ANTHROPIC_BASE_URL="$BASE_URL" \
ANTHROPIC_AUTH_TOKEN="$AUTH_TOKEN" \
ANTHROPIC_MODEL="$MODEL" \
claude -p -r "$SESSION_ID" "How many letters are in the token we discussed? Reply only with the number." >/tmp/codex-proxy-turn3.txt

if [[ "$(cat /tmp/codex-proxy-turn3.txt)" != "2" ]]; then
  echo "turn3 failed: $(cat /tmp/codex-proxy-turn3.txt)" >&2
  exit 1
fi

cat /tmp/codex-proxy-turn1.txt
cat /tmp/codex-proxy-turn2.txt
cat /tmp/codex-proxy-turn3.txt
