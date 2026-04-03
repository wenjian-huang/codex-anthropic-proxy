#!/bin/bash
set -euo pipefail
BASE_URL="${PROXY_BASE_URL:-http://127.0.0.1:4141}"
AUTH_TOKEN="${PROXY_AUTH_TOKEN:-dummy-local-token}"
MODEL="${PROXY_MODEL:-sonnet}"

ANTHROPIC_BASE_URL="$BASE_URL" \
ANTHROPIC_AUTH_TOKEN="$AUTH_TOKEN" \
ANTHROPIC_MODEL="$MODEL" \
claude -p "Reply with exactly OK"
