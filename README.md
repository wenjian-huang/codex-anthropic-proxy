# codex-anthropic-proxy

本地 Anthropic Messages API 兼容代理，内部通过 `/Users/concefly/.codex/auth.json` 的 ChatGPT 登录态调用 Codex/OpenAI Responses 后端。

当前已实现的兼容点：

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `request-id` 响应头与错误体 `request_id`
- `HEAD /` 健康探测
- Claude Code 的多轮会话验证

## 运行

```bash
cd /Users/concefly/Project/codex-anthropic-proxy
node src/index.mjs
```

默认监听 `http://127.0.0.1:4141`。

## 验证

```bash
bash scripts/smoke-curl.sh
bash scripts/smoke-claude.sh
bash scripts/smoke-claude-multiturn.sh
```

注意：

- `claude -c` 在 `--print` 场景下这次没有稳定续上上一轮会话。
- 多轮验证请用精确 `-r <session_id>` 恢复已有会话。
- `scripts/smoke-claude-multiturn.sh` 已经按这个方式实现。

## 关键环境变量

- `HOST`
- `PORT`
- `CODEX_AUTH_FILE`
- `CODEX_UPSTREAM_BASE_URL`
- `CODEX_REFRESH_URL`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_MODEL`
