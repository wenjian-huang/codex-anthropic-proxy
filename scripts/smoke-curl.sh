#!/bin/bash
set -euo pipefail
BASE_URL="${PROXY_BASE_URL:-http://127.0.0.1:4141}"
AUTH_TOKEN="${PROXY_AUTH_TOKEN:-dummy-local-token}"

curl -sS "$BASE_URL/healthz" >/dev/null
curl -sS "$BASE_URL/readyz" >/dev/null

curl -sS "$BASE_URL/v1/messages" \
  -H "content-type: application/json" \
  -H "x-api-key: $AUTH_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 64,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Reply with exactly OK"}
    ]
  }'
