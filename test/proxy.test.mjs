import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  server,
  streamAnthropicResponse
} from '../src/index.mjs';

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

test('`createContinuationRequest` reports prefix mismatch reason', () => {
  resetSessionState();
  rememberSessionResponse('session-1', {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }]
  }, 'resp-1');

  const request = createContinuationRequest(
    {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'different history' }]
    },
    { claudeSessionId: 'session-1' },
    buildResponsesRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'different history' }]
    }, { claudeSessionId: 'session-1' })
  );

  assert.equal(request.usedContinuation, false);
  assert.equal(request.continuationReason, 'messages_prefix_mismatch');
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
  resetSessionState();
  server.listen(4141, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:4141/v1/messages/count_tokens', {
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
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('server implements `/v1/messages/count_tokens`', { concurrency: false }, async () => {
  resetSessionState();
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
  server.listen(4141, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:4141/v1/messages/count_tokens', {
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
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = originalFetch;
  }
});

test('server forwards Anthropic image blocks to upstream `input_image`', { concurrency: false }, async () => {
  resetSessionState();
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
  server.listen(4141, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:4141/v1/messages/count_tokens', {
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
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = originalFetch;
  }
});

test('server falls back to estimated count_tokens when upstream input_tokens is forbidden html', { concurrency: false }, async () => {
  resetSessionState();
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
  server.listen(4141, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:4141/v1/messages/count_tokens', {
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
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = originalFetch;
  }
});

test('server reuses previous_response_id with incremental input for same Claude session', { concurrency: false }, async () => {
  resetSessionState();
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
  server.listen(4141, '127.0.0.1');
  await once(server, 'listening');
  try {
    const headers = {
      'content-type': 'application/json',
      [ANTHROPIC_VERSION_HEADER]: '2023-06-01',
      'x-claude-code-session-id': 'session-abc'
    };
    const first = await fetch('http://127.0.0.1:4141/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    assert.equal(first.status, 200);

    const second = await fetch('http://127.0.0.1:4141/v1/messages', {
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
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = originalFetch;
  }
});

test('continuation request falls back to full context when previous_response_id is not found', async () => {
  resetSessionState();
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
    const firstBody = {
      model: 'claude-sonnet-4-6',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    };
    rememberSessionResponse('session-retry', firstBody, 'resp-1');
    const secondBody = {
      model: 'claude-sonnet-4-6',
      stream: false,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
        { role: 'user', content: 'follow up' }
      ]
    };
    const prepared = createContinuationRequest(
      secondBody,
      { claudeSessionId: 'session-retry' },
      buildResponsesRequest(secondBody, { claudeSessionId: 'session-retry' })
    );
    const response = await callCodexResponsesWithFallback(prepared, {
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
