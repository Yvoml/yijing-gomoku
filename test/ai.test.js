import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { runAgent, isPublicAddress, validateBaseUrl } from '../lib/ai.js';
import { createBoard, boardFromMoves, BLACK, WHITE, chooseMove } from '../lib/engine.js';

async function mockEndpoint(handler, work) {
  const oldPrivate = process.env.ALLOW_PRIVATE_AI_ENDPOINTS;
  process.env.ALLOW_PRIVATE_AI_ENDPOINTS = 'true';
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    try { await handler(JSON.parse(raw), request, response); }
    catch (error) { response.writeHead(500).end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await work(`http://127.0.0.1:${server.address().port}/v1`); }
  finally {
    await new Promise(resolve => server.close(resolve));
    if (oldPrivate === undefined) delete process.env.ALLOW_PRIVATE_AI_ENDPOINTS;
    else process.env.ALLOW_PRIVATE_AI_ENDPOINTS = oldPrivate;
  }
}

function completion(response, message) {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message }] }));
}

test('SSRF filter rejects local, private, reserved, mapped and transition addresses', async () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fd00::1', 'fe80::1', '2001::', '2001::1', '2001:db8::1', '2002:7f00:1::']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
  for (const url of ['http://8.8.8.8/v1', 'https://127.0.0.1/v1', 'https://2130706433/v1', 'https://[::ffff:127.0.0.1]/v1', 'https://localhost/v1', 'https://example.com/v1?key=secret', 'https://user:password@example.com/v1', 'file:///etc/passwd']) {
    await assert.rejects(validateBaseUrl(url, { allowPrivate: false }), undefined, url);
  }
});

test('unconfigured and disabled AI uses local engine without revealing configuration', async () => {
  const oldKey = process.env.AI_API_KEY;
  const oldShared = process.env.ALLOW_SHARED_AI;
  process.env.AI_API_KEY = 'server-secret';
  process.env.ALLOW_SHARED_AI = 'false';
  try {
    const local = await runAgent({ board: createBoard(), player: BLACK });
    assert.equal(local.agent.source, 'local');
    assert.equal(local.agent.fallback, false);
    const disabled = await runAgent({ board: createBoard(), player: BLACK, ai: { disabled: true, apiKey: 'secret', baseUrl: 'https://127.0.0.1' } });
    assert.equal(disabled.agent.source, 'local');
    assert.equal(JSON.stringify([local, disabled]).includes('secret'), false);
  } finally {
    if (oldKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = oldKey;
    if (oldShared === undefined) delete process.env.ALLOW_SHARED_AI; else process.env.ALLOW_SHARED_AI = oldShared;
  }
});

test('remote agent inspects, compares candidates, and submits a validated move', async () => {
  let count = 0;
  const board = createBoard();
  board[7][7] = BLACK;
  await mockEndpoint((body, request, response) => {
    count++;
    assert.equal(request.headers.authorization, 'Bearer test-secret');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(body.max_tokens, 512);
    if (count === 1) completion(response, { tool_calls: [
      { id: 'inspect-1', type: 'function', function: { name: 'inspect_board', arguments: '{}' } },
      { id: 'candidates-1', type: 'function', function: { name: 'candidate_moves', arguments: '{}' } },
    ] });
    else {
      const candidates = JSON.parse(body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'candidates-1').content).candidates;
      completion(response, { tool_calls: [{ id: 'submit-1', type: 'function', function: { name: 'submit_move', arguments: JSON.stringify({ ...candidates[0], explanation: '先保持联系，再限制对手活三。' }) } }] });
    }
  }, async baseUrl => {
    const result = await runAgent({ board, player: WHITE, purpose: 'move', ai: { baseUrl, apiKey: 'test-secret', model: 'mock-model' } });
    assert.equal(result.agent.source, 'remote');
    assert.equal(count, 2);
    assert.equal(result.agent.steps.at(-1).tool, 'submit_move');
    assert.ok(result.analysis.coach.includes('活三'));
    assert.equal(board[result.move.y][result.move.x], 0);
    assert.equal(JSON.stringify(result).includes('test-secret'), false);
  });
});

test('tool-incompatible APIs use validated JSON and keep tactical wins', async () => {
  let calls = 0;
  const board = createBoard();
  for (let x = 0; x < 4; x++) board[0][x] = BLACK;
  await mockEndpoint((body, _request, response) => {
    calls++;
    if (body.tools) response.writeHead(400).end('{"error":"tools unsupported"}');
    else completion(response, { content: JSON.stringify({ x: 4, y: 0, explanation: '直接成五。' }) });
  }, async baseUrl => {
    const result = await runAgent({ board, player: BLACK, ai: { baseUrl, apiKey: 'secret' } });
    assert.equal(calls, 2);
    assert.equal(result.agent.source, 'remote');
    assert.equal(result.move.x, 4);
    assert.equal(result.move.y, 0);
  });
});

test('illegal remote moves, service errors and round limits fall back without secrets', async () => {
  const board = createBoard();
  await mockEndpoint((_body, _request, response) => completion(response, { content: '{"x":99,"y":99,"explanation":"bad"}' }), async baseUrl => {
    const result = await runAgent({ board, player: BLACK, ai: { baseUrl, apiKey: 'private-secret' } });
    assert.equal(result.agent.source, 'local');
    assert.equal(result.agent.fallback, true);
    assert.deepEqual(result.move, chooseMove(board, BLACK));
    assert.equal(JSON.stringify(result).includes('private-secret'), false);
  });
  let rounds = 0;
  await mockEndpoint((_body, _request, response) => {
    rounds++;
    completion(response, { tool_calls: [{ id: `inspect-${rounds}`, type: 'function', function: { name: 'inspect_board', arguments: '{}' } }] });
  }, async baseUrl => {
    const result = await runAgent({ board, player: BLACK, ai: { baseUrl, apiKey: 'secret' } });
    assert.equal(rounds, 3);
    assert.equal(result.agent.fallback, true);
  });
  await mockEndpoint((_body, _request, response) => response.writeHead(401).end('{"error":"private-secret"}'), async baseUrl => {
    const result = await runAgent({ board, player: BLACK, ai: { baseUrl, apiKey: 'private-secret' } });
    assert.equal(result.agent.fallback, true);
    assert.match(result.agent.message, /401/);
    assert.equal(JSON.stringify(result).includes('private-secret'), false);
  });
});

test('analysis-only JSON provides coaching without inventing a move', async () => {
  await mockEndpoint((_body, _request, response) => completion(response, { content: '{"analysis":"中心尚未形成连续威胁，可先发展活三。"}' }), async baseUrl => {
    const result = await runAgent({ board: createBoard(), player: BLACK, purpose: 'analyze', ai: { baseUrl, apiKey: 'secret' } });
    assert.equal(result.agent.source, 'remote');
    assert.match(result.analysis.coach, /活三/);
    assert.equal(result.move.x, 7);
  });
});

test('remote text redacts the request key and oversized responses fall back', async () => {
  await mockEndpoint((_body, _request, response) => completion(response, { content: '{"analysis":"key=should-never-persist"}' }), async baseUrl => {
    const result = await runAgent({ board: createBoard(), player: BLACK, purpose: 'analyze', ai: { baseUrl, apiKey: 'should-never-persist' } });
    assert.equal(result.agent.source, 'remote');
    assert.equal(JSON.stringify(result).includes('should-never-persist'), false);
  });
  await mockEndpoint((_body, _request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('x'.repeat(1024 * 1024 + 1));
  }, async baseUrl => {
    const result = await runAgent({ board: createBoard(), player: BLACK, ai: { baseUrl, apiKey: 'secret' } });
    assert.equal(result.agent.fallback, true);
  });
});

test('an already aborted signal never contacts the remote endpoint', async () => {
  let requests = 0;
  await mockEndpoint((_body, _request, response) => { requests++; completion(response, {}); }, async baseUrl => {
    const result = await runAgent({ board: createBoard(), player: BLACK, ai: { baseUrl, apiKey: 'secret' }, signal: AbortSignal.abort() });
    assert.equal(result.agent.fallback, true);
    assert.equal(requests, 0);
  });
});

test('difficulty affects local choices, provider candidates, and fallback without stale hints', async () => {
  // This opening separates the quick pattern choice from the reply-search move.
  const board = boardFromMoves([
    { x: 5, y: 8, player: BLACK }, { x: 5, y: 4, player: WHITE },
    { x: 4, y: 6, player: BLACK }, { x: 6, y: 7, player: WHITE },
  ]);
  const easy = await runAgent({ board, player: BLACK, difficulty: 'easy', ai: { disabled: true } });
  const hard = await runAgent({ board, player: BLACK, difficulty: 'hard', ai: { disabled: true } });
  assert.deepEqual([easy.move.x, easy.move.y], [5, 6]);
  assert.deepEqual([hard.move.x, hard.move.y], [4, 7]);
  assert.deepEqual([easy.analysis.recommendation.x, easy.analysis.recommendation.y], [5, 6]);
  assert.match(easy.analysis.summary, /F9/);
  assert.deepEqual([hard.analysis.recommendation.x, hard.analysis.recommendation.y], [4, 7]);
  await mockEndpoint((body, _request, response) => {
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual([input.candidates[0].x, input.candidates[0].y], [4, 7]);
    response.writeHead(503).end('{}');
  }, async baseUrl => {
    const result = await runAgent({ board, player: BLACK, difficulty: 'hard', ai: { baseUrl, apiKey: 'secret' } });
    assert.equal(result.agent.fallback, true);
    assert.deepEqual([result.move.x, result.move.y], [4, 7]);
    assert.deepEqual([result.analysis.recommendation.x, result.analysis.recommendation.y], [4, 7]);
  });
  await mockEndpoint((body, _request, response) => {
    const candidate = JSON.parse(body.messages[1].content).candidates[1];
    completion(response, { content: JSON.stringify({ ...candidate, explanation: '选择另一候选点，保持棋子联系。' }) });
  }, async baseUrl => {
    const result = await runAgent({ board, player: BLACK, difficulty: 'hard', ai: { baseUrl, apiKey: 'secret' } });
    assert.equal(result.agent.source, 'remote');
    assert.deepEqual([result.move.x, result.move.y], [5, 6]);
    assert.deepEqual([result.analysis.recommendation.x, result.analysis.recommendation.y], [5, 6]);
    assert.match(result.analysis.summary, /F9/);
  });
});

test('shared deployment credentials ignore visitor endpoints and models; own credentials can customize them', async () => {
  const names = ['ALLOW_SHARED_AI', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let trustedRequests = 0;
  let visitorRequests = 0;
  try {
    await mockEndpoint((body, request, response) => {
      trustedRequests++;
      assert.equal(request.headers.authorization, 'Bearer deployment-private-key');
      assert.equal(body.model, 'trusted-model');
      completion(response, { content: '{"x":7,"y":7,"explanation":"中心布局。"}' });
    }, async trustedBaseUrl => {
      process.env.ALLOW_SHARED_AI = 'true';
      process.env.AI_API_KEY = 'deployment-private-key';
      process.env.AI_BASE_URL = trustedBaseUrl;
      process.env.AI_MODEL = 'trusted-model';
      await mockEndpoint((body, request, response) => {
        visitorRequests++;
        assert.equal(request.headers.authorization, 'Bearer visitor-own-key');
        assert.equal(body.model, 'visitor-model');
        completion(response, { content: '{"x":7,"y":7,"explanation":"保持中心联系。"}' });
      }, async visitorBaseUrl => {
        const sharedResult = await runAgent({
          board: createBoard(), player: BLACK,
          ai: { baseUrl: visitorBaseUrl, model: 'visitor-model' },
        });
        assert.equal(sharedResult.agent.source, 'remote');
        assert.equal(trustedRequests, 1);
        assert.equal(visitorRequests, 0, 'shared credential must never reach visitor endpoint');
        assert.equal(JSON.stringify(sharedResult).includes('deployment-private-key'), false);
        const ownResult = await runAgent({
          board: createBoard(), player: BLACK,
          ai: { baseUrl: visitorBaseUrl, model: 'visitor-model', apiKey: 'visitor-own-key' },
        });
        assert.equal(ownResult.agent.source, 'remote');
        assert.equal(trustedRequests, 1);
        assert.equal(visitorRequests, 1);
        assert.equal(JSON.stringify(ownResult).includes('visitor-own-key'), false);
      });
    });
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
