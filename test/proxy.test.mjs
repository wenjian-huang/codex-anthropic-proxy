import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import {
  ANTHROPIC_VERSION_HEADER,
  AUTH_FILE,
  buildResponsesInputTokensRequest,
  buildResponsesRequest,
  callCodexResponsesWithFallback,
  createContinuationRequest,
  DEFAULT_AUTH_FILE,
  estimateInputTokens,
  parseRequestContext,
  requireAnthropicHeaders,
  resetSessionState,
  rememberSessionResponse,
  streamAnthropicResponse
} from '../src/index.mjs';

const MODULE_URL = pathToFileURL(new URL('../src/index.mjs', import.meta.url).pathname).href;

function createFakeReq(headers = {}) {
  return {
    headers,
    method: 'POST'
  };
}

function createFakeRes() {
  const chunks = [];
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end(chunk = '') {
      if (chunk) {
        chunks.push(String(chunk));
      }
      this.body = chunks.join('');
    }
  };
}

function createSseStream(events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    }
  });
}

async function readReadableStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

async function importProxyModuleWithEnv(env) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await import(`${MODULE_URL}?t=${Date.now()}-${Math.random()}`);
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withProxyServerEnv(env, run) {
  const proxy = await importProxyModuleWithEnv(env);
  proxy.resetSessionState();
  await new Promise((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
  const address = proxy.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(proxy, baseUrl);
  } finally {
    await new Promise((resolve, reject) => proxy.server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('`buildResponsesRequest` keeps assistant history as `output_text`', () => {
  const request = buildResponsesRequest({
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' }
    ]
  });

  assert.equal(request.model, 'gpt-5.4');
  assert.deepEqual(request.input[0], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'hello' }]
  });
  assert.deepEqual(request.input[1], {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'world' }]
  });
  assert.equal(request.prompt_cache_key, undefined);
});

test('`buildResponsesRequest` maps Anthropic image URL blocks to `input_image`', () => {
  const request = buildResponsesRequest({
    model: 'claude-sonnet-4-6',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        {
          type: 'image',
          source: {
            type: 'url',
            url: 'https://example.com/cat.png'
          }
        }
      ]
    }]
  });

  assert.deepEqual(request.input[0], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'look' }]
  });
  assert.deepEqual(request.input[1], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_image', image_url: 'https://example.com/cat.png' }]
  });
});

test('`buildResponsesRequest` maps Anthropic base64 image blocks to data URLs', () => {
  const request = buildResponsesRequest({
    model: 'claude-sonnet-4-6',
    messages: [{
      role: 'user',
      content: [{
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'Zm9v'
        }
      }]
    }]
  });

  assert.deepEqual(request.input[0], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_image', image_url: 'data:image/png;base64,Zm9v' }]
  });
});

test('`buildResponsesRequest` uses Claude session id as prompt_cache_key', () => {
  const request = buildResponsesRequest(
    {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }]
    },
    { claudeSessionId: 'session-123' }
  );

  assert.equal(request.prompt_cache_key, 'session-123');
});

test('`buildResponsesInputTokensRequest` reuses mapped request fields', () => {
  const request = buildResponsesInputTokensRequest(
    {
      model: 'claude-sonnet-4-6',
      system: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'calculator',
        description: 'adds numbers',
        input_schema: { type: 'object' }
      }]
    },
    { claudeSessionId: 'session-123' }
  );

  assert.equal(request.model, 'gpt-5.4');
  assert.equal(request.instructions, 'system');
  assert.equal(request.input.length, 1);
  assert.equal(request.tools.length, 1);
  assert.equal(request.prompt_cache_key, 'session-123');
});

test('`createContinuationRequest` keeps per-model session buckets separate', () => {
  resetSessionState();
  rememberSessionResponse('shared-session', {
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'haiku hello' }]
  }, 'resp-haiku');
  rememberSessionResponse('shared-session', {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'tool-a', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'sonnet hello' }]
  }, 'resp-sonnet');

  const request = createContinuationRequest(
    {
      model: 'claude-sonnet-4-6',
      tools: [{ name: 'tool-a', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'sonnet hello' },
        { role: 'assistant', content: 'world' }
      ]
    },
    { claudeSessionId: 'shared-session' },
    buildResponsesRequest({
      model: 'claude-sonnet-4-6',
      tools: [{ name: 'tool-a', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'sonnet hello' },
        { role: 'assistant', content: 'world' }
      ]
    }, { claudeSessionId: 'shared-session' })
  );

  assert.equal(request.usedContinuation, true);
  assert.equal(request.continuationReason, 'continued');
  assert.equal(request.request.previous_response_id, 'resp-sonnet');
});

test('`createContinuationRequest` keeps per-branch session buckets separate within one Claude session', () => {
  resetSessionState();
  rememberSessionResponse('shared-session', {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'review efficiency only' }]
  }, 'resp-efficiency');
  rememberSessionResponse('shared-session', {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'review reuse opportunities only' }]
  }, 'resp-reuse');

  const request = createContinuationRequest(
    {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'review reuse opportunities only' },
        { role: 'assistant', content: 'done' }
      ]
    },
    { claudeSessionId: 'shared-session' },
    buildResponsesRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'review reuse opportunities only' },
        { role: 'assistant', content: 'done' }
      ]
    }, { claudeSessionId: 'shared-session' })
  );

  assert.equal(request.usedContinuation, true);
  assert.equal(request.continuationReason, 'continued');
  assert.equal(request.request.previous_response_id, 'resp-reuse');
});

test('`createContinuationRequest` reports prefix mismatch reason', () => {
  resetSessionState();
  rememberSessionResponse('session-1', {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' }
    ]
  }, 'resp-1');

  const request = createContinuationRequest(
    {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'different history' }
      ]
    },
    { claudeSessionId: 'session-1' },
    buildResponsesRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'different history' }
      ]
    }, { claudeSessionId: 'session-1' })
  );

  assert.equal(request.usedContinuation, false);
  assert.equal(request.continuationReason, 'messages_prefix_mismatch');
  assert.equal(request.diagnostics.messagesDiff.mismatchIndex, 1);
  assert.equal(request.diagnostics.messagesDiff.previousMessage.role, 'assistant');
  assert.match(request.diagnostics.messagesDiff.previousMessage.preview, /world/);
  assert.match(request.diagnostics.messagesDiff.currentMessage.preview, /different history/);
});

test('`createContinuationRequest` includes system diff diagnostics on system mismatch', () => {
  resetSessionState();
  rememberSessionResponse('session-system', {
    model: 'claude-sonnet-4-6',
    system: 'base instructions alpha',
    messages: [{ role: 'user', content: 'hello' }]
  }, 'resp-1');

  const request = createContinuationRequest(
    {
      model: 'claude-sonnet-4-6',
      system: 'base instructions beta with extra context',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' }
      ]
    },
    { claudeSessionId: 'session-system' },
    buildResponsesRequest({
      model: 'claude-sonnet-4-6',
      system: 'base instructions beta with extra context',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' }
      ]
    }, { claudeSessionId: 'session-system' })
  );

  assert.equal(request.usedContinuation, false);
  assert.equal(request.continuationReason, 'system_mismatch');
  assert.equal(request.diagnostics.systemDiff.previousLength, 'base instructions alpha'.length);
  assert.equal(request.diagnostics.systemDiff.currentLength, 'base instructions beta with extra context'.length);
  assert.ok(request.diagnostics.systemDiff.sharedPrefixLength > 0);
  assert.match(request.diagnostics.systemDiff.previousPreview, /alpha/);
  assert.match(request.diagnostics.systemDiff.currentPreview, /beta/);
});

test('`createContinuationRequest` ignores tiny dynamic system token changes', () => {
  resetSessionState();
  rememberSessionResponse('session-dynamic', {
    model: 'claude-sonnet-4-6',
    system: `${'A'.repeat(74)}77ab9${'B'.repeat(27621)}`,
    messages: [{ role: 'user', content: 'hello' }]
  }, 'resp-1');

  const request = createContinuationRequest(
    {
      model: 'claude-sonnet-4-6',
      system: `${'A'.repeat(74)}90ec1${'B'.repeat(27621)}`,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' }
      ]
    },
    { claudeSessionId: 'session-dynamic' },
    buildResponsesRequest({
      model: 'claude-sonnet-4-6',
      system: `${'A'.repeat(74)}90ec1${'B'.repeat(27621)}`,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' }
      ]
    }, { claudeSessionId: 'session-dynamic' })
  );

  assert.equal(request.usedContinuation, true);
  assert.equal(request.continuationReason, 'continued');
  assert.equal(request.request.previous_response_id, 'resp-1');
});

test('`estimateInputTokens` counts text, system and tools', () => {
  const count = estimateInputTokens({
    system: 'system prompt',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'hello world' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'Zm9v'
          }
        }
      ]
    }],
    tools: [
      {
        name: 'calculator',
        description: 'adds numbers',
        input_schema: { type: 'object', properties: { a: { type: 'number' } } }
      }
    ]
  });

  assert.ok(count >= 10);
});

test('default auth file comes from current home directory', () => {
  assert.equal(DEFAULT_AUTH_FILE, join(homedir(), '.codex', 'auth.json'));
  if (!process.env.CODEX_AUTH_FILE) {
    assert.equal(AUTH_FILE, DEFAULT_AUTH_FILE);
  }
});

test('`requireAnthropicHeaders` rejects missing version header', () => {
  const context = parseRequestContext(createFakeReq());
  assert.throws(() => requireAnthropicHeaders(context), /anthropic-version/);
});

test('`streamAnthropicResponse` emits text, ping and tool_use events', async () => {
  const res = createFakeRes();
  const upstream = {
    body: createSseStream([
      'event: message\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
      'event: message\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"shell","arguments":"{\\"cmd\\":\\"pwd\\"}"}}\n\n',
      'event: message\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":7}}}\n\n'
    ])
  };

  await streamAnthropicResponse(res, upstream, 'claude-sonnet-4-6', 'req_test');

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['request-id'], 'req_test');
  assert.match(res.body, /event: message_start/);
  assert.match(res.body, /event: content_block_delta/);
  assert.match(res.body, /"type":"text_delta","text":"Hello"/);
  assert.match(res.body, /"type":"input_json_delta","partial_json":"\{\\\"cmd\\\":\\\"pwd\\\"\}"/);
  assert.match(res.body, /"stop_reason":"tool_use"/);
});

test('server returns request-id and 400 on missing `anthropic-version`', { concurrency: false }, async () => {
  await withProxyServerEnv({ CODEX_UPSTREAM_WEBSOCKETS: '0' }, async (_proxy, baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.ok(response.headers.get('request-id'));
    assert.equal(payload.type, 'error');
    assert.match(payload.error.message, /anthropic-version/);
  });
});

test('server implements `/v1/messages/count_tokens`', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody = null;
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://chatgpt.com/backend-api/codex/responses/input_tokens') {
      upstreamBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        object: 'response.input_tokens',
        input_tokens: 42
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return originalFetch(url, options);
  };
  try {
    await withProxyServerEnv({ CODEX_UPSTREAM_WEBSOCKETS: '0' }, async (_proxy, baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ANTHROPIC_VERSION_HEADER]: '2023-06-01',
          'x-claude-code-session-id': 'session-123'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'hello' }]
        })
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('request-id'));
      assert.equal(payload.input_tokens, 42);
      assert.deepEqual(upstreamBody.input[0], {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }]
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server forwards Anthropic image blocks to upstream `input_image`', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody = null;
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://chatgpt.com/backend-api/codex/responses/input_tokens') {
      upstreamBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        object: 'response.input_tokens',
        input_tokens: 64
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return originalFetch(url, options);
  };
  try {
    await withProxyServerEnv({ CODEX_UPSTREAM_WEBSOCKETS: '0' }, async (_proxy, baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ANTHROPIC_VERSION_HEADER]: '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          messages: [{
            role: 'user',
            content: [{
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'Zm9v'
              }
            }]
          }]
        })
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.input_tokens, 64);
      assert.deepEqual(upstreamBody.input[0], {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,Zm9v' }]
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server falls back to estimated count_tokens when upstream input_tokens is forbidden html', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://chatgpt.com/backend-api/codex/responses/input_tokens') {
      return new Response('<html><body>forbidden</body></html>', {
        status: 403,
        headers: { 'content-type': 'text/html' }
      });
    }
    return originalFetch(url, options);
  };
  try {
    await withProxyServerEnv({ CODEX_UPSTREAM_WEBSOCKETS: '0' }, async (_proxy, baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ANTHROPIC_VERSION_HEADER]: '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'hello world' }]
        })
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.ok(payload.input_tokens > 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server reuses previous_response_id with incremental input for same Claude session', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://chatgpt.com/backend-api/codex/responses') {
      const body = JSON.parse(options.body);
      upstreamBodies.push(body);
      const responseId = upstreamBodies.length === 1 ? 'resp-1' : 'resp-2';
      return new Response(
        [
          `event: message\ndata: ${JSON.stringify({ type: 'response.created', response: { id: responseId } })}\n\n`,
          `event: message\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`
        ].join(''),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        }
      );
    }
    return originalFetch(url, options);
  };
  try {
    await withProxyServerEnv({ CODEX_UPSTREAM_WEBSOCKETS: '0' }, async (_proxy, baseUrl) => {
      const headers = {
        'content-type': 'application/json',
        [ANTHROPIC_VERSION_HEADER]: '2023-06-01',
        'x-claude-code-session-id': 'session-abc'
      };
      const first = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          stream: false,
          messages: [{ role: 'user', content: 'hello' }]
        })
      });
      assert.equal(first.status, 200);

      const second = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          stream: false,
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'world' },
            { role: 'user', content: 'follow up' }
          ]
        })
      });
      assert.equal(second.status, 200);
      assert.equal(upstreamBodies.length, 2);
      assert.equal(upstreamBodies[0].previous_response_id, undefined);
      assert.equal(upstreamBodies[1].previous_response_id, 'resp-1');
      assert.deepEqual(upstreamBodies[1].input, [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'world' }]
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'follow up' }]
        }
      ]);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('continuation request falls back to full context when previous_response_id is not found', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://chatgpt.com/backend-api/codex/responses') {
      const body = JSON.parse(options.body);
      upstreamBodies.push(body);
      if (upstreamBodies.length === 1) {
        return new Response(JSON.stringify({
          error: { message: 'previous_response_not_found' }
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(
        [
          `event: message\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-2' } })}\n\n`,
          `event: message\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-2', usage: { input_tokens: 20, output_tokens: 8 } } })}\n\n`
        ].join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    }
    return originalFetch(url, options);
  };
  try {
    const proxy = await importProxyModuleWithEnv({ CODEX_UPSTREAM_WEBSOCKETS: '0' });
    proxy.resetSessionState();
    const firstBody = {
      model: 'claude-sonnet-4-6',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    };
    proxy.rememberSessionResponse('session-retry', firstBody, 'resp-1');
    const secondBody = {
      model: 'claude-sonnet-4-6',
      stream: false,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
        { role: 'user', content: 'follow up' }
      ]
    };
    const prepared = proxy.createContinuationRequest(
      secondBody,
      { claudeSessionId: 'session-retry' },
      proxy.buildResponsesRequest(secondBody, { claudeSessionId: 'session-retry' })
    );
    const response = await proxy.callCodexResponsesWithFallback(prepared, {
      tokens: { access_token: 'test-token' }
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 2);
    assert.equal(upstreamBodies[0].previous_response_id, 'resp-1');
    assert.equal(upstreamBodies[1].previous_response_id, undefined);
    assert.deepEqual(upstreamBodies[1].input, [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }]
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'world' }]
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'follow up' }]
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('`callCodexResponsesWithFallback` can stream over upstream websocket', async () => {
  const httpServer = createHttpServer();
  const websocketServer = new WebSocketServer({ noServer: true });
  const messages = [];
  let handshakeHeaders = null;

  httpServer.on('upgrade', (request, socket, head) => {
    handshakeHeaders = request.headers;
    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      websocketServer.emit('connection', ws, request);
    });
  });

  websocketServer.on('connection', (ws) => {
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString('utf8')));
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp-ws-1' } }));
      ws.send(JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'OK'
      }));
      ws.send(JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp-ws-1',
          usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } }
        }
      }));
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const proxy = await importProxyModuleWithEnv({
    CODEX_UPSTREAM_BASE_URL: `http://127.0.0.1:${port}`
  });

  try {
    proxy.resetSessionState();
    const context = {
      claudeSessionId: 'session-ws',
      requestId: 'req-ws'
    };
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello websocket' }]
    };
    const prepared = proxy.createContinuationRequest(
      body,
      context,
      proxy.buildResponsesRequest(body, context)
    );
    const upstream = await proxy.callCodexResponsesWithFallback(prepared, {
      tokens: {
        access_token: 'access-token',
        account_id: 'acct-123'
      }
    }, context);

    const payload = await readReadableStream(upstream.body);
    assert.match(payload, /response\.created/);
    assert.match(payload, /response\.output_text\.delta/);
    assert.match(payload, /response\.completed/);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'response.create');
    assert.equal(messages[0].model, 'gpt-5.4');
    assert.equal(messages[0].input[0].content[0].text, 'hello websocket');
    assert.equal(handshakeHeaders.authorization, 'Bearer access-token');
    assert.equal(handshakeHeaders['chatgpt-account-id'], 'acct-123');
    assert.equal(handshakeHeaders['openai-beta'], 'responses_websockets=2026-02-06');
  } finally {
    proxy.resetSessionState();
    await new Promise((resolve, reject) => websocketServer.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test('`callCodexResponsesWithFallback` degrades to http after websocket handshake failure', async () => {
  const httpServer = createHttpServer((req, res) => {
    if (req.method === 'POST' && req.url === '/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          `event: message\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-http-1' } })}\n\n`,
          `event: message\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-http-1', usage: { input_tokens: 9, output_tokens: 2 } } })}\n\n`
        ].join('')
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  httpServer.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const proxy = await importProxyModuleWithEnv({
    CODEX_UPSTREAM_BASE_URL: `http://127.0.0.1:${port}`
  });

  try {
    proxy.resetSessionState();
    const context = {
      claudeSessionId: 'session-http-fallback',
      requestId: 'req-http-fallback'
    };
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello fallback' }]
    };
    const prepared = proxy.createContinuationRequest(
      body,
      context,
      proxy.buildResponsesRequest(body, context)
    );
    const upstream = await proxy.callCodexResponsesWithFallback(prepared, {
      tokens: { access_token: 'access-token' }
    }, context);

    const payload = await readReadableStream(upstream.body);
    assert.match(payload, /response\.completed/);

    const secondUpstream = await proxy.callCodexResponsesWithFallback(prepared, {
      tokens: { access_token: 'access-token' }
    }, context);
    const secondPayload = await readReadableStream(secondUpstream.body);
    assert.match(secondPayload, /response\.completed/);
  } finally {
    proxy.resetSessionState();
    await new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test('`callCodexResponsesWithFallback` serializes websocket requests within one bucket', async () => {
  const httpServer = createHttpServer();
  const websocketServer = new WebSocketServer({ noServer: true });
  const messages = [];
  let releaseFirstResponse;
  const firstResponseReleased = new Promise((resolve) => {
    releaseFirstResponse = resolve;
  });

  httpServer.on('upgrade', (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      websocketServer.emit('connection', ws, request);
    });
  });

  websocketServer.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      const payload = JSON.parse(raw.toString('utf8'));
      messages.push(payload);
      const responseId = `resp-ws-${messages.length}`;
      ws.send(JSON.stringify({ type: 'response.created', response: { id: responseId } }));
      if (messages.length === 1) {
        await firstResponseReleased;
      }
      ws.send(JSON.stringify({
        type: 'response.completed',
        response: {
          id: responseId,
          usage: { input_tokens: 12, output_tokens: 4 }
        }
      }));
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const proxy = await importProxyModuleWithEnv({
    CODEX_UPSTREAM_BASE_URL: `http://127.0.0.1:${port}`
  });

  try {
    proxy.resetSessionState();
    const context = {
      claudeSessionId: 'session-ws-serial',
      requestId: 'req-ws-serial'
    };
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello websocket' }]
    };
    const prepared = proxy.createContinuationRequest(
      body,
      context,
      proxy.buildResponsesRequest(body, context)
    );

    const firstUpstreamPromise = proxy.callCodexResponsesWithFallback(prepared, {
      tokens: { access_token: 'access-token' }
    }, context);
    const secondUpstreamPromise = proxy.callCodexResponsesWithFallback(prepared, {
      tokens: { access_token: 'access-token' }
    }, context);

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(messages.length, 1);

    releaseFirstResponse();

    const firstUpstream = await firstUpstreamPromise;
    const secondUpstream = await secondUpstreamPromise;
    const firstPayload = await readReadableStream(firstUpstream.body);
    const secondPayload = await readReadableStream(secondUpstream.body);

    assert.match(firstPayload, /response\.completed/);
    assert.match(secondPayload, /response\.completed/);
    assert.equal(messages.length, 2);
  } finally {
    proxy.resetSessionState();
    await new Promise((resolve, reject) => websocketServer.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test('`callCodexResponsesWithFallback` surfaces websocket overload after response start without unhandled rejection', async () => {
  const httpServer = createHttpServer();
  const websocketServer = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      websocketServer.emit('connection', ws, request);
    });
  });

  websocketServer.on('connection', (ws) => {
    ws.on('message', () => {
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp-ws-overloaded' } }));
      ws.send(JSON.stringify({
        type: 'error',
        error: { message: 'Our servers are currently overloaded. Please try again later.' }
      }));
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const proxy = await importProxyModuleWithEnv({
    CODEX_UPSTREAM_BASE_URL: `http://127.0.0.1:${port}`
  });

  try {
    proxy.resetSessionState();
    const context = {
      claudeSessionId: 'session-ws-overloaded',
      requestId: 'req-ws-overloaded'
    };
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello websocket' }]
    };
    const prepared = proxy.createContinuationRequest(
      body,
      context,
      proxy.buildResponsesRequest(body, context)
    );
    const upstream = await proxy.callCodexResponsesWithFallback(prepared, {
      tokens: { access_token: 'access-token' }
    }, context);

    await assert.rejects(readReadableStream(upstream.body), /overloaded/);
  } finally {
    proxy.resetSessionState();
    await new Promise((resolve, reject) => websocketServer.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test('`callCodexResponsesWithFallback` surfaces websocket idle timeout without reference errors', async () => {
  const httpServer = createHttpServer();
  const websocketServer = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      websocketServer.emit('connection', ws, request);
    });
  });

  websocketServer.on('connection', (ws) => {
    ws.on('message', () => {
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp-ws-idle' } }));
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const proxy = await importProxyModuleWithEnv({
    CODEX_UPSTREAM_BASE_URL: `http://127.0.0.1:${port}`,
    CODEX_UPSTREAM_WS_IDLE_TIMEOUT_MS: '20'
  });

  try {
    proxy.resetSessionState();
    const context = {
      claudeSessionId: 'session-ws-idle',
      requestId: 'req-ws-idle'
    };
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello websocket' }]
    };
    const prepared = proxy.createContinuationRequest(
      body,
      context,
      proxy.buildResponsesRequest(body, context)
    );
    const upstream = await proxy.callCodexResponsesWithFallback(prepared, {
      tokens: { access_token: 'access-token' }
    }, context);

    await assert.rejects(readReadableStream(upstream.body), /idle timeout/);
  } finally {
    proxy.resetSessionState();
    await new Promise((resolve, reject) => websocketServer.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
  }
});
