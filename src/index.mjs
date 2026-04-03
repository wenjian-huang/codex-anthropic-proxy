import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? '4141');
const DEFAULT_AUTH_FILE = join(homedir(), '.codex', 'auth.json');
const AUTH_FILE = process.env.CODEX_AUTH_FILE ?? DEFAULT_AUTH_FILE;
const UPSTREAM_BASE_URL = (process.env.CODEX_UPSTREAM_BASE_URL ?? 'https://chatgpt.com/backend-api/codex').replace(/\/$/, '');
const REFRESH_URL = process.env.CODEX_REFRESH_URL ?? 'https://auth.openai.com/oauth/token';
const CLIENT_ID = process.env.CODEX_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_REFRESH_SKEW_SECONDS = Number(process.env.CODEX_TOKEN_REFRESH_SKEW_SECONDS ?? '60');
const DEBUG = process.env.DEBUG_PROXY === '1';
const VERBOSE = process.env.PROXY_VERBOSE !== '0';

const MODEL_MAP = {
  default: process.env.CODEX_DEFAULT_MODEL ?? 'gpt-5.4',
  opus: process.env.CODEX_MODEL_MAP_OPUS ?? 'gpt-5.4',
  sonnet: process.env.CODEX_MODEL_MAP_SONNET ?? 'gpt-5.4',
  haiku: process.env.CODEX_MODEL_MAP_HAIKU ?? 'gpt-5.4-mini'
};

let refreshInFlight = null;
const sessionState = new Map();
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ANTHROPIC_VERSION_HEADER = 'anthropic-version';

function createRequestId() {
  return `req_${randomUUID().replace(/-/g, '')}`;
}

function logPrefix() {
  return `[proxy ${new Date().toISOString()}]`;
}

function log(...args) {
  if (VERBOSE) {
    console.error(logPrefix(), ...args);
  }
}

function debugLog(...args) {
  if (DEBUG) {
    console.error(logPrefix(), ...args);
  }
}

function summarizeHeaders(context) {
  return {
    anthropicVersion: context.anthropicVersion ?? null,
    anthropicBeta: context.anthropicBeta ?? null,
    claudeSessionId: context.claudeSessionId ?? null,
    userAgent: context.userAgent ?? null,
    hasAuthToken: Boolean(context.authToken)
  };
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function extractCachedInputTokens(usage) {
  return usage?.input_tokens_details?.cached_tokens
    ?? usage?.cached_input_tokens
    ?? 0;
}

function stableHash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 10);
}

function previewText(value, maxLength = 80) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function countSharedPrefix(a, b) {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function countSharedSuffix(a, b, prefixLength = 0) {
  const max = Math.min(a.length, b.length) - prefixLength;
  let count = 0;
  while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count]) {
    count += 1;
  }
  return count;
}

function summarizeSystemDiff(previousSystem, currentSystem) {
  const sharedPrefixLength = countSharedPrefix(previousSystem, currentSystem);
  const sharedSuffixLength = countSharedSuffix(previousSystem, currentSystem, sharedPrefixLength);
  const previousMiddle = previousSystem.slice(
    sharedPrefixLength,
    Math.max(sharedPrefixLength, previousSystem.length - sharedSuffixLength)
  );
  const currentMiddle = currentSystem.slice(
    sharedPrefixLength,
    Math.max(sharedPrefixLength, currentSystem.length - sharedSuffixLength)
  );
  return {
    previousLength: previousSystem.length,
    currentLength: currentSystem.length,
    sharedPrefixLength,
    sharedSuffixLength,
    previousMiddleLength: previousMiddle.length,
    currentMiddleLength: currentMiddle.length,
    previousPreview: previewText(previousMiddle),
    currentPreview: previewText(currentMiddle)
  };
}

function canIgnoreSystemDiff(systemDiff) {
  if (!systemDiff) {
    return false;
  }
  if (systemDiff.previousLength !== systemDiff.currentLength) {
    return false;
  }
  const sharedTotal = systemDiff.sharedPrefixLength + systemDiff.sharedSuffixLength;
  const minLength = Math.min(systemDiff.previousLength, systemDiff.currentLength);
  const sharedRatio = minLength === 0 ? 1 : sharedTotal / minLength;
  return systemDiff.previousMiddleLength > 0
    && systemDiff.previousMiddleLength <= 8
    && systemDiff.previousMiddleLength === systemDiff.currentMiddleLength
    && sharedRatio >= 0.99;
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(JSON.stringify(payload));
}

function sendAnthropicError(res, status, message, type = 'invalid_request_error', requestId = createRequestId()) {
  sendJson(res, status, {
    type: 'error',
    error: { type, message },
    request_id: requestId
  }, { 'request-id': requestId });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    throw new Error('Empty request body');
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON body: ${error.message}`);
  }
}

function parseRequestContext(req) {
  const requestId = createRequestId();
  return {
    requestId,
    anthropicVersion: req.headers[ANTHROPIC_VERSION_HEADER],
    anthropicBeta: req.headers['anthropic-beta'],
    claudeSessionId: req.headers['x-claude-code-session-id'],
    userAgent: req.headers['user-agent'],
    authToken: req.headers['x-api-key'] ?? req.headers.authorization ?? null
  };
}

function requireAnthropicHeaders(context) {
  if (!context.anthropicVersion || typeof context.anthropicVersion !== 'string') {
    throw new Error('Missing required header: anthropic-version');
  }
}

function extractJwtPayload(token) {
  try {
    const [, payload] = token.split('.');
    if (!payload) {
      return null;
    }
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function tokenExpiresSoon(token) {
  const payload = extractJwtPayload(token);
  if (!payload?.exp) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  return payload.exp <= now + TOKEN_REFRESH_SKEW_SECONDS;
}

async function loadAuthFile() {
  const raw = await readFile(AUTH_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.auth_mode !== 'chatgpt') {
    throw new Error(`Unsupported auth_mode in ${AUTH_FILE}: ${parsed.auth_mode ?? 'missing'}`);
  }
  const tokens = parsed.tokens ?? {};
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error(`Missing access_token or refresh_token in ${AUTH_FILE}`);
  }
  return parsed;
}

async function persistAuthFile(nextAuth) {
  const tempPath = join(tmpdir(), `codex-auth-${process.pid}-${Date.now()}.json`);
  await writeFile(tempPath, `${JSON.stringify(nextAuth, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, AUTH_FILE);
}

async function refreshAuthIfNeeded(force = false) {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const auth = await loadAuthFile();
      if (!force && !tokenExpiresSoon(auth.tokens.access_token)) {
        return auth;
      }
      log('refreshing access token');
      const response = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: auth.tokens.refresh_token
        })
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Token refresh failed with ${response.status}: ${text}`);
      }
      const refreshed = JSON.parse(text);
      const nextAuth = structuredClone(auth);
      nextAuth.tokens.access_token = refreshed.access_token;
      nextAuth.tokens.refresh_token = refreshed.refresh_token ?? auth.tokens.refresh_token;
      if (refreshed.id_token) {
        nextAuth.tokens.id_token = refreshed.id_token;
      }
      const idTokenPayload = refreshed.id_token ? extractJwtPayload(refreshed.id_token) : extractJwtPayload(auth.tokens.id_token ?? '');
      if (idTokenPayload?.chatgpt_account_id) {
        nextAuth.tokens.account_id = idTokenPayload.chatgpt_account_id;
      }
      nextAuth.last_refresh = new Date().toISOString();
      await persistAuthFile(nextAuth);
      log('access token refreshed');
      return nextAuth;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function anthropicSystemToString(system) {
  if (!system) {
    return '';
  }
  if (typeof system === 'string') {
    return system;
  }
  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (typeof block === 'string') {
          return block;
        }
        if (block?.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        throw new Error(`Unsupported system block type: ${block?.type ?? typeof block}`);
      })
      .join('\n\n');
  }
  throw new Error('Unsupported system field');
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  throw new Error('Message content must be a string or an array');
}

function convertTextBlock(role, text) {
  return {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }]
  };
}

function imageBlockToImageUrl(block) {
  const source = block?.source;
  if (!source || typeof source !== 'object') {
    throw new Error('Image block must include a source object');
  }
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || !source.url) {
      throw new Error('Image URL source must include a non-empty url');
    }
    return source.url;
  }
  if (source.type === 'base64') {
    if (typeof source.media_type !== 'string' || !source.media_type) {
      throw new Error('Base64 image source must include media_type');
    }
    if (typeof source.data !== 'string' || !source.data) {
      throw new Error('Base64 image source must include data');
    }
    return `data:${source.media_type};base64,${source.data}`;
  }
  throw new Error(`Unsupported image source type: ${source.type ?? typeof source}`);
}

function convertImageBlock(block) {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_image', image_url: imageBlockToImageUrl(block) }]
  };
}

function convertToolUseBlock(block) {
  return {
    type: 'function_call',
    name: block.name,
    arguments: JSON.stringify(block.input ?? {}),
    call_id: block.id
  };
}

function convertToolResultBlock(block) {
  const outputText = Array.isArray(block.content)
    ? block.content.map((item) => item?.text ?? '').join('')
    : typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content ?? '');
  return {
    type: 'function_call_output',
    call_id: block.tool_use_id,
    output: [{ type: 'input_text', text: outputText }]
  };
}

function anthropicMessagesToResponsesInput(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }
  const input = [];
  for (const message of messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
      throw new Error(`Unsupported message role: ${message?.role ?? 'missing'}`);
    }
    for (const block of normalizeMessageContent(message.content)) {
      if (block?.type === 'text') {
        input.push(convertTextBlock(message.role, block.text ?? ''));
        continue;
      }
      if (message.role === 'user' && block?.type === 'image') {
        input.push(convertImageBlock(block));
        continue;
      }
      if (message.role === 'assistant' && block?.type === 'tool_use') {
        input.push(convertToolUseBlock(block));
        continue;
      }
      if (message.role === 'user' && block?.type === 'tool_result') {
        input.push(convertToolResultBlock(block));
        continue;
      }
      throw new Error(`Unsupported content block type: ${block?.type ?? typeof block}`);
    }
  }
  return input;
}

function summarizeAnthropicMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.map((message, index) => {
    const blocks = normalizeMessageContent(message.content);
    return {
      index,
      role: message.role,
      blocks: blocks.map((block) => block?.type ?? typeof block),
      preview: blocks
        .map((block) => {
          if (block?.type === 'text') {
            return block.text ?? '';
          }
          if (block?.type === 'image') {
            return `<image:${block.source?.type ?? 'unknown'}>`;
          }
          if (block?.type === 'tool_use') {
            return `<tool_use:${block.name ?? 'unknown'}>`;
          }
          if (block?.type === 'tool_result') {
            return `<tool_result:${block.tool_use_id ?? 'unknown'}>`;
          }
          return `<${block?.type ?? typeof block}>`;
        })
        .join(' ')
        .slice(0, 160)
    };
  });
}

function convertTools(tools) {
  if (!tools) {
    return [];
  }
  if (!Array.isArray(tools)) {
    throw new Error('tools must be an array');
  }
  return tools.map((tool) => {
    if (!tool?.name || !tool?.input_schema) {
      throw new Error('Every tool must include name and input_schema');
    }
    return {
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      strict: false,
      parameters: tool.input_schema
    };
  });
}

function mapModel(model) {
  if (typeof model !== 'string' || !model) {
    return MODEL_MAP.default;
  }
  const lower = model.toLowerCase();
  if (lower.includes('opus')) {
    return MODEL_MAP.opus;
  }
  if (lower.includes('haiku')) {
    return MODEL_MAP.haiku;
  }
  if (lower.includes('sonnet')) {
    return MODEL_MAP.sonnet;
  }
  return MODEL_MAP.default;
}

function mapThinking(thinking) {
  if (!thinking || thinking.type !== 'enabled') {
    return null;
  }
  const budget = Number(thinking.budget_tokens ?? 0);
  const effort = budget >= 4096 ? 'high' : budget >= 1024 ? 'medium' : 'low';
  return { effort };
}

function estimateInputTokens(body) {
  const parts = [];
  const pushText = (value) => {
    if (typeof value === 'string' && value) {
      parts.push(value);
    }
  };
  pushText(anthropicSystemToString(body.system));
  for (const message of body.messages ?? []) {
    pushText(message.role);
    for (const block of normalizeMessageContent(message.content)) {
      if (block?.type === 'text') {
        pushText(block.text ?? '');
        continue;
      }
      if (block?.type === 'image') {
        pushText(imageBlockToImageUrl(block));
        continue;
      }
      if (block?.type === 'tool_use') {
        pushText(block.name ?? '');
        pushText(JSON.stringify(block.input ?? {}));
        continue;
      }
      if (block?.type === 'tool_result') {
        pushText(block.tool_use_id ?? '');
        pushText(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''));
        continue;
      }
      throw new Error(`Unsupported content block type: ${block?.type ?? typeof block}`);
    }
  }
  for (const tool of body.tools ?? []) {
    pushText(tool.name ?? '');
    pushText(tool.description ?? '');
    pushText(JSON.stringify(tool.input_schema ?? {}));
  }
  pushText(JSON.stringify(body.thinking ?? null));
  const totalChars = parts.join('\n').length;
  return Math.max(1, Math.ceil(totalChars / 4));
}

function getSessionSnapshot(sessionKey) {
  if (!sessionKey) {
    return null;
  }
  return sessionState.get(sessionKey) ?? null;
}

function createSessionBucketKey(body, context) {
  if (!context.claudeSessionId) {
    return null;
  }
  return JSON.stringify({
    claudeSessionId: context.claudeSessionId,
    model: mapModel(body.model)
  });
}

function messagesHavePrefix(previousMessages, nextMessages) {
  if (!Array.isArray(previousMessages) || !Array.isArray(nextMessages)) {
    return false;
  }
  if (previousMessages.length > nextMessages.length) {
    return false;
  }
  return previousMessages.every((message, index) => JSON.stringify(message) === JSON.stringify(nextMessages[index]));
}

function createContinuationRequest(body, context, fullRequest) {
  const sessionKey = createSessionBucketKey(body, context);
  const snapshot = getSessionSnapshot(sessionKey);
  const system = anthropicSystemToString(body.system);
  const toolsKey = JSON.stringify(body.tools ?? []);
  const diagnostics = {
    sessionBucketKey: sessionKey,
    systemHash: stableHash(system),
    toolsHash: stableHash(toolsKey),
    snapshotSystemHash: snapshot?.systemHash ?? null,
    snapshotToolsHash: snapshot?.toolsHash ?? null,
    systemDiff: snapshot?.system ? summarizeSystemDiff(snapshot.system, system) : null
  };
  if (!snapshot?.lastResponseId) {
    return {
      request: fullRequest,
      fullRequest,
      usedContinuation: false,
      deltaMessageCount: 0,
      continuationReason: 'no_snapshot',
      diagnostics
    };
  }
  const systemMatches = snapshot.system === system || canIgnoreSystemDiff(diagnostics.systemDiff);
  if (!systemMatches || snapshot.toolsKey !== toolsKey) {
    return {
      request: fullRequest,
      fullRequest,
      usedContinuation: false,
      deltaMessageCount: 0,
      continuationReason: !systemMatches ? 'system_mismatch' : 'tools_mismatch',
      diagnostics
    };
  }
  const currentMessages = Array.isArray(body.messages) ? body.messages : [];
  if (!messagesHavePrefix(snapshot.messages, currentMessages)) {
    return {
      request: fullRequest,
      fullRequest,
      usedContinuation: false,
      deltaMessageCount: 0,
      continuationReason: 'messages_prefix_mismatch',
      diagnostics
    };
  }
  const deltaMessages = currentMessages.slice(snapshot.messages.length);
  if (deltaMessages.length === 0) {
    return {
      request: fullRequest,
      fullRequest,
      usedContinuation: false,
      deltaMessageCount: 0,
      continuationReason: 'empty_delta',
      diagnostics
    };
  }
  return {
    request: {
      ...fullRequest,
      input: anthropicMessagesToResponsesInput(deltaMessages),
      previous_response_id: snapshot.lastResponseId
    },
    fullRequest,
    usedContinuation: true,
    deltaMessageCount: deltaMessages.length,
    continuationReason: 'continued',
    diagnostics
  };
}

function rememberSessionResponse(claudeSessionId, body, responseId) {
  const sessionKey = createSessionBucketKey(body, { claudeSessionId });
  if (!sessionKey || !responseId) {
    return;
  }
  sessionState.set(sessionKey, {
    lastResponseId: responseId,
    system: anthropicSystemToString(body.system),
    toolsKey: JSON.stringify(body.tools ?? []),
    systemHash: stableHash(anthropicSystemToString(body.system)),
    toolsHash: stableHash(JSON.stringify(body.tools ?? [])),
    messages: cloneJson(body.messages ?? [])
  });
}

function shouldRetryWithoutPreviousResponse(status, text) {
  if (status < 400 || !text) {
    return false;
  }
  return text.includes('previous_response_not_found')
    || text.includes('previous_response_id')
    || text.includes('previous response');
}

function buildResponsesRequest(body, context = {}) {
  return {
    model: mapModel(body.model),
    instructions: anthropicSystemToString(body.system),
    input: anthropicMessagesToResponsesInput(body.messages),
    tools: convertTools(body.tools),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: mapThinking(body.thinking),
    store: false,
    stream: true,
    include: [],
    prompt_cache_key: context.claudeSessionId ?? undefined
  };
}

function buildResponsesInputTokensRequest(body, context = {}) {
  const request = buildResponsesRequest(body, context);
  return {
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    tools: request.tools,
    tool_choice: request.tool_choice,
    parallel_tool_calls: request.parallel_tool_calls,
    reasoning: request.reasoning,
    prompt_cache_key: request.prompt_cache_key
  };
}

async function callCodexResponses(requestBody, auth, retryOnUnauthorized = true) {
  log('upstream request', '/responses', 'model=', requestBody.model, 'items=', requestBody.input.length, 'tools=', requestBody.tools.length);
  const response = await fetch(`${UPSTREAM_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${auth.tokens.access_token}`,
      ...(auth.tokens.account_id ? { 'ChatGPT-Account-ID': auth.tokens.account_id } : {})
    },
    body: JSON.stringify(requestBody)
  });

  if (response.status === 401 && retryOnUnauthorized) {
    log('upstream 401, refreshing token and retrying once');
    const refreshed = await refreshAuthIfNeeded(true);
    return callCodexResponses(requestBody, refreshed, false);
  }

  if (!response.ok) {
    const text = await response.text();
    log('upstream error', response.status, text.slice(0, 300));
    throw new Error(`Upstream /responses failed with ${response.status}: ${text}`);
  }

  log('upstream response accepted', response.status);
  return response;
}

async function callCodexInputTokens(requestBody, auth, retryOnUnauthorized = true) {
  log('upstream request', '/responses/input_tokens', 'model=', requestBody.model, 'items=', requestBody.input.length, 'tools=', requestBody.tools.length);
  const response = await fetch(`${UPSTREAM_BASE_URL}/responses/input_tokens`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${auth.tokens.access_token}`,
      ...(auth.tokens.account_id ? { 'ChatGPT-Account-ID': auth.tokens.account_id } : {})
    },
    body: JSON.stringify(requestBody)
  });

  if (response.status === 401 && retryOnUnauthorized) {
    log('upstream input_tokens 401, refreshing token and retrying once');
    const refreshed = await refreshAuthIfNeeded(true);
    return callCodexInputTokens(requestBody, refreshed, false);
  }

  if (!response.ok) {
    const text = await response.text();
    log('upstream input_tokens error', response.status, text.slice(0, 300));
    throw new Error(`Upstream /responses/input_tokens failed with ${response.status}: ${text}`);
  }

  const payload = await response.json();
  log('upstream input_tokens accepted', response.status, 'input_tokens=', payload.input_tokens ?? 'missing');
  return payload;
}

function shouldFallbackCountTokens(error) {
  const message = error?.message ?? '';
  return message.includes('/responses/input_tokens failed with 403')
    || message.includes('/responses/input_tokens failed with 404')
    || message.includes('/responses/input_tokens failed with 405')
    || message.includes('/responses/input_tokens failed with 415')
    || message.includes('<html');
}

async function callCodexResponsesWithFallback(preparedRequest, auth) {
  try {
    return await callCodexResponses(preparedRequest.request, auth, true);
  } catch (error) {
    if (!preparedRequest.usedContinuation || !shouldRetryWithoutPreviousResponse(500, error.message ?? '')) {
      throw error;
    }
    log('continuation request failed, retrying with full context');
    return callCodexResponses(preparedRequest.fullRequest, auth, true);
  }
}

async function callCodexInputTokensWithFallback(preparedRequest, auth) {
  try {
    return await callCodexInputTokens(preparedRequest.request, auth, true);
  } catch (error) {
    if (!preparedRequest.usedContinuation || !shouldRetryWithoutPreviousResponse(500, error.message ?? '')) {
      throw error;
    }
    log('continuation input_tokens failed, retrying with full context');
    return callCodexInputTokens(preparedRequest.fullRequest, auth, true);
  }
}

async function* parseSse(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const index = buffer.indexOf('\n\n');
      if (index === -1) {
        break;
      }
      const rawEvent = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const lines = rawEvent.split(/\r?\n/);
      const event = { event: 'message', data: '' };
      for (const line of lines) {
        if (line.startsWith('event:')) {
          event.event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          event.data += `${line.slice(5).trim()}\n`;
        }
      }
      event.data = event.data.replace(/\n$/, '');
      if (event.data) {
        yield event;
      }
    }
  }
}

function anthropicMessageEnvelope(model) {
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 }
  };
}

function writeSse(res, payload) {
  res.write(`event: ${payload.type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeAnthropicPing(res) {
  writeSse(res, { type: 'ping' });
}

async function streamAnthropicResponse(res, upstream, requestedModel, requestId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'request-id': requestId
  });

  const state = {
    message: anthropicMessageEnvelope(requestedModel),
    responseId: null,
    textBlockOpen: false,
    sawToolUse: false,
    currentThinkingIndex: null,
    currentTextIndex: 0,
    aggregatedText: '',
    blocks: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    cachedInputTokens: 0
  };
  const pingTimer = setInterval(() => writeAnthropicPing(res), 10000);

  try {
    writeSse(res, { type: 'message_start', message: state.message });

    for await (const event of parseSse(upstream.body)) {
      if (event.data === '[DONE]' || event.event === 'ping') {
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        writeSse(res, {
          type: 'error',
          error: { type: 'api_error', message: 'Invalid upstream SSE payload' }
        });
        break;
      }
      if (payload.type === 'error') {
        writeSse(res, {
          type: 'error',
          error: payload.error ?? { type: 'api_error', message: 'Upstream SSE error' }
        });
        break;
      }
      if (payload.type === 'response.created' || payload.type === 'response.in_progress') {
        const responseId = payload.response?.id;
        if (typeof responseId === 'string' && responseId) {
          state.responseId = responseId;
        }
        continue;
      }
      if (payload.type === 'response.reasoning_text.delta') {
        if (state.currentThinkingIndex === null) {
          state.currentThinkingIndex = 0;
          writeSse(res, {
            type: 'content_block_start',
            index: state.currentThinkingIndex,
            content_block: { type: 'thinking', thinking: '' }
          });
        }
        writeSse(res, {
          type: 'content_block_delta',
          index: state.currentThinkingIndex,
          delta: { type: 'thinking_delta', thinking: payload.delta ?? '' }
        });
        continue;
      }
      if (payload.type === 'response.output_text.delta') {
        if (!state.textBlockOpen) {
          state.textBlockOpen = true;
          writeSse(res, {
            type: 'content_block_start',
            index: state.currentTextIndex,
            content_block: { type: 'text', text: '' }
          });
        }
        state.aggregatedText += payload.delta ?? '';
        writeSse(res, {
          type: 'content_block_delta',
          index: state.currentTextIndex,
          delta: { type: 'text_delta', text: payload.delta ?? '' }
        });
        continue;
      }
      if (payload.type === 'response.output_item.done') {
        const item = payload.item ?? {};
        if (item.type === 'message') {
          const text = Array.isArray(item.content)
            ? item.content.filter((part) => part?.text).map((part) => part.text).join('')
            : '';
          if (text && !state.textBlockOpen && !state.aggregatedText) {
            writeSse(res, {
              type: 'content_block_start',
              index: state.currentTextIndex,
              content_block: { type: 'text', text: '' }
            });
            writeSse(res, {
              type: 'content_block_delta',
              index: state.currentTextIndex,
              delta: { type: 'text_delta', text }
            });
            state.aggregatedText = text;
            state.textBlockOpen = true;
          }
        } else if (item.type === 'function_call') {
          const index = state.blocks.length + (state.textBlockOpen ? 1 : 0) + (state.currentThinkingIndex === null ? 0 : 1);
          state.sawToolUse = true;
          let input = {};
          let partialJson = item.arguments ?? '{}';
          try {
            input = JSON.parse(partialJson);
          } catch {
            input = { raw: item.arguments ?? '' };
            partialJson = JSON.stringify(input);
          }
          const block = {
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: {}
          };
          state.blocks.push(block);
          writeSse(res, { type: 'content_block_start', index, content_block: block });
          writeSse(res, {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: partialJson }
          });
          writeSse(res, { type: 'content_block_stop', index });
        }
        continue;
      }
      if (payload.type === 'response.completed') {
        const responseId = payload.response?.id;
        if (typeof responseId === 'string' && responseId) {
          state.responseId = responseId;
        }
        const usage = payload.response?.usage ?? payload.usage ?? {};
        state.usage = {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0
        };
        state.cachedInputTokens = extractCachedInputTokens(usage);
      }
    }

    if (state.currentThinkingIndex !== null) {
      writeSse(res, { type: 'content_block_stop', index: state.currentThinkingIndex });
    }
    if (state.textBlockOpen) {
      writeSse(res, { type: 'content_block_stop', index: state.currentTextIndex });
    }
    writeSse(res, {
      type: 'message_delta',
      delta: { stop_reason: state.sawToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: state.usage
    });
    writeSse(res, { type: 'message_stop' });
    res.end();
    return { responseId: state.responseId, usage: state.usage, cachedInputTokens: state.cachedInputTokens };
  } finally {
    clearInterval(pingTimer);
  }
}

async function collectAnthropicResponse(upstream, requestedModel) {
  const result = {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 }
  };
  let text = '';
  let responseId = null;
  let cachedInputTokens = 0;
  for await (const event of parseSse(upstream.body)) {
    if (event.data === '[DONE]') {
      continue;
    }
    const payload = JSON.parse(event.data);
    if (payload.type === 'response.created' || payload.type === 'response.in_progress') {
      const currentResponseId = payload.response?.id;
      if (typeof currentResponseId === 'string' && currentResponseId) {
        responseId = currentResponseId;
      }
    }
    if (payload.type === 'response.output_text.delta') {
      text += payload.delta ?? '';
    }
    if (payload.type === 'response.output_item.done') {
      const item = payload.item ?? {};
      if (item.type === 'function_call') {
        result.content.push({
          type: 'tool_use',
          id: item.call_id,
          name: item.name,
          input: JSON.parse(item.arguments ?? '{}')
        });
        result.stop_reason = 'tool_use';
      }
      if (item.type === 'message' && !text) {
        const finalText = Array.isArray(item.content)
          ? item.content.filter((part) => part?.text).map((part) => part.text).join('')
          : '';
        if (finalText) {
          text = finalText;
        }
      }
    }
    if (payload.type === 'response.completed') {
      const currentResponseId = payload.response?.id;
      if (typeof currentResponseId === 'string' && currentResponseId) {
        responseId = currentResponseId;
      }
      const usage = payload.response?.usage ?? payload.usage ?? {};
      result.usage = {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0
      };
      cachedInputTokens = extractCachedInputTokens(usage);
    }
  }
  if (text) {
    result.content.unshift({ type: 'text', text });
  }
  return { payload: result, responseId, cachedInputTokens };
}

async function handleCountTokens(req, res, context) {
  try {
    requireAnthropicHeaders(context);
    const body = await readJsonBody(req);
    const auth = await refreshAuthIfNeeded(false);
    const preparedRequest = createContinuationRequest(body, context, buildResponsesInputTokensRequest(body, context));
    let inputTokens;
    let mode = 'upstream';
    try {
      const payload = await callCodexInputTokensWithFallback(preparedRequest, auth);
      inputTokens = payload.input_tokens;
    } catch (error) {
      if (!shouldFallbackCountTokens(error)) {
        throw error;
      }
      mode = 'fallback_estimate';
      inputTokens = estimateInputTokens(body);
      log('count_tokens fallback to estimate', context.requestId, error.message);
    }
    log(
      'count_tokens request',
      context.requestId,
      'tokens=',
      inputTokens,
      'mode=',
      mode,
      'continuation=',
      preparedRequest.usedContinuation,
      'reason=',
      preparedRequest.continuationReason,
      'system_hash=',
      preparedRequest.diagnostics.systemHash,
      'tools_hash=',
      preparedRequest.diagnostics.toolsHash,
      'snapshot_system_hash=',
      preparedRequest.diagnostics.snapshotSystemHash ?? 'none',
      'snapshot_tools_hash=',
      preparedRequest.diagnostics.snapshotToolsHash ?? 'none',
      'system_diff=',
      preparedRequest.diagnostics.systemDiff ? JSON.stringify(preparedRequest.diagnostics.systemDiff) : 'none',
      'previous_response_id=',
      preparedRequest.request.previous_response_id ?? 'none',
      'delta_messages=',
      preparedRequest.deltaMessageCount ?? 0,
      'headers=',
      JSON.stringify(summarizeHeaders(context))
    );
    sendJson(res, 200, { input_tokens: inputTokens }, { 'request-id': context.requestId });
  } catch (error) {
    log('count_tokens failed', context.requestId, error.message);
    sendAnthropicError(res, 400, error.message, 'invalid_request_error', context.requestId);
  }
}

async function handleMessages(req, res, context) {
  try {
    requireAnthropicHeaders(context);
    const body = await readJsonBody(req);
    const auth = await refreshAuthIfNeeded(false);
    const preparedRequest = createContinuationRequest(body, context, buildResponsesRequest(body, context));
    const responsesRequest = preparedRequest.request;
    log('messages request', context.requestId, 'headers=', JSON.stringify(summarizeHeaders(context)));
    debugLog('anthropic messages', JSON.stringify(summarizeAnthropicMessages(body.messages)));
    log(
      'request model',
      body.model,
      'mapped to',
      responsesRequest.model,
      'stream=',
      body.stream !== false,
      'continuation=',
      preparedRequest.usedContinuation,
      'reason=',
      preparedRequest.continuationReason,
      'system_hash=',
      preparedRequest.diagnostics.systemHash,
      'tools_hash=',
      preparedRequest.diagnostics.toolsHash,
      'snapshot_system_hash=',
      preparedRequest.diagnostics.snapshotSystemHash ?? 'none',
      'snapshot_tools_hash=',
      preparedRequest.diagnostics.snapshotToolsHash ?? 'none',
      'system_diff=',
      preparedRequest.diagnostics.systemDiff ? JSON.stringify(preparedRequest.diagnostics.systemDiff) : 'none',
      'previous_response_id=',
      responsesRequest.previous_response_id ?? 'none',
      'delta_messages=',
      preparedRequest.deltaMessageCount ?? 0
    );
    const upstream = await callCodexResponsesWithFallback(preparedRequest, auth);
    if (body.stream === false) {
      const result = await collectAnthropicResponse(upstream, body.model ?? 'claude-sonnet-4-5');
      rememberSessionResponse(context.claudeSessionId, body, result.responseId);
      const payload = result.payload;
      log(
        'messages request completed',
        context.requestId,
        'mode=json',
        'stop_reason=',
        payload.stop_reason,
        'input_tokens=',
        payload.usage.input_tokens,
        'cached_input_tokens=',
        result.cachedInputTokens,
        'output_tokens=',
        payload.usage.output_tokens
      );
      sendJson(res, 200, payload, { 'request-id': context.requestId });
      return;
    }
    const result = await streamAnthropicResponse(res, upstream, body.model ?? 'claude-sonnet-4-5', context.requestId);
    rememberSessionResponse(context.claudeSessionId, body, result?.responseId);
    log(
      'messages request completed',
      context.requestId,
      'mode=sse',
      'input_tokens=',
      result?.usage?.input_tokens ?? 0,
      'cached_input_tokens=',
      result?.cachedInputTokens ?? 0,
      'output_tokens=',
      result?.usage?.output_tokens ?? 0
    );
  } catch (error) {
    log('request failed', context.requestId, error.stack ?? error.message);
    const status = error.message?.startsWith('Missing required header') ? 400 : 500;
    const type = status === 400 ? 'invalid_request_error' : 'api_error';
    sendAnthropicError(res, status, error.message, type, context.requestId);
  }
}

export const server = createServer(async (req, res) => {
  if (!req.url) {
    sendAnthropicError(res, 404, 'Not found');
    return;
  }

  const context = parseRequestContext(req);
  const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = requestUrl.pathname.replace(/\/+$/, '') || '/';
  log('incoming', req.method ?? 'UNKNOWN', req.url, 'request_id=', context.requestId);

  if (req.method === 'HEAD' && pathname === '/') {
    res.writeHead(200, { 'request-id': context.requestId });
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true }, { 'request-id': context.requestId });
    return;
  }

  if (req.method === 'GET' && pathname === '/readyz') {
    try {
      await refreshAuthIfNeeded(false);
      sendJson(res, 200, { ok: true, authFile: AUTH_FILE }, { 'request-id': context.requestId });
    } catch (error) {
      sendAnthropicError(res, 503, error.message, 'authentication_error', context.requestId);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/messages') {
    await handleMessages(req, res, context);
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
    await handleCountTokens(req, res, context);
    return;
  }

  sendAnthropicError(res, 404, 'Not found', 'invalid_request_error', context.requestId);
});

export function startServer() {
  return server.listen(PORT, HOST, () => {
    console.error(`codex-anthropic-proxy listening on http://${HOST}:${PORT}`);
  });
}

export function resetSessionState() {
  sessionState.clear();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

export {
  ANTHROPIC_VERSION_HEADER,
  AUTH_FILE,
  buildResponsesRequest,
  buildResponsesInputTokensRequest,
  callCodexResponsesWithFallback,
  createContinuationRequest,
  DEFAULT_AUTH_FILE,
  estimateInputTokens,
  parseRequestContext,
  requireAnthropicHeaders,
  rememberSessionResponse,
  streamAnthropicResponse
};
