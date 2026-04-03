import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import {
  ANTHROPIC_VERSION_HEADER,
  buildResponsesRequest,
  estimateInputTokens,
  parseRequestContext,
  requireAnthropicHeaders,
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
});

test('`estimateInputTokens` counts text, system and tools', () => {
  const count = estimateInputTokens({
    system: 'system prompt',
    messages: [{ role: 'user', content: 'hello world' }],
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

test('server returns request-id and 400 on missing `anthropic-version`', async () => {
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

test('server implements `/v1/messages/count_tokens`', async () => {
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
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('request-id'));
    assert.ok(payload.input_tokens >= 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
