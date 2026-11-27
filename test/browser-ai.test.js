import test from 'node:test';
import assert from 'node:assert/strict';
import { runBrowserAgent } from '../browser/ai.js';
import { createBoard, boardFromMoves, chooseMove, BLACK, WHITE } from '../lib/engine.js';

const ai = { baseUrl: 'https://models.example/v1/', model: 'own-model', apiKey: 'private-test-key' };
const reply = message => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const tool = (name, args = {}) => ({ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('browser local AI needs no network, honors difficulty, and never mutates the board', async () => {
  const board = boardFromMoves([
    { x: 5, y: 8, player: BLACK }, { x: 5, y: 4, player: WHITE },
    { x: 4, y: 6, player: BLACK }, { x: 6, y: 7, player: WHITE },
  ]);
  const before = structuredClone(board);
  let calls = 0;
  const fetchImpl = () => { calls++; throw new Error('must not request'); };
  const easy = await runBrowserAgent({ board, player: BLACK, difficulty: 'easy', fetchImpl });
  const hard = await runBrowserAgent({ board, player: BLACK, difficulty: 'hard', ai: { ...ai, disabled: true }, fetchImpl });
  assert.deepEqual([easy.move.x, easy.move.y], [5, 6]);
  assert.deepEqual([hard.move.x, hard.move.y], [4, 7]);
  assert.deepEqual(easy.analysis.recommendation, easy.move);
  assert.equal(calls, 0);
  assert.deepEqual(board, before);
});

test('browser agent runs a bounded tool loop and sends a key only to the selected HTTPS endpoint', async () => {
  const board = createBoard(); board[7][7] = BLACK;
  let calls = 0;
  const result = await runBrowserAgent({ board, player: WHITE, ai, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://models.example/v1/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${ai.apiKey}`);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.mode, 'cors'); assert.equal(options.referrerPolicy, 'no-referrer');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'own-model');
    const candidate = JSON.parse(payload.messages[1].content).candidates[0];
    if (calls === 1) return reply({ tool_calls: [tool('inspect_board'), tool('candidate_moves')] });
    assert.ok(payload.messages.some(message => message.role === 'tool'));
    return reply({ tool_calls: [tool('submit_move', { ...candidate, explanation: '先守住连接点。' })] });
  } });
  assert.equal(calls, 2); assert.equal(result.agent.source, 'remote');
  assert.equal(result.analysis.coach, '先守住连接点。');
  assert.deepEqual(result.agent.steps.map(step => step.tool), ['inspect_board', 'candidate_moves', 'submit_move']);
  assert.equal(board[result.move.y][result.move.x], 0);
  assert.equal(JSON.stringify(result).includes(ai.apiKey), false);
});

test('CORS and network failures give an actionable local fallback without exposing errors or secrets', async () => {
  const result = await runBrowserAgent({ board: createBoard(), player: BLACK, ai, fetchImpl: async () => { throw new TypeError(`network ${ai.apiKey}`); } });
  assert.equal(result.agent.source, 'local'); assert.equal(result.agent.fallback, true);
  assert.match(result.agent.message, /跨域.*CORS/);
  assert.equal(JSON.stringify(result).includes(ai.apiKey), false);
});

test('tool-incompatible providers retry structured JSON and redact keys in coaching', async () => {
  let calls = 0;
  const result = await runBrowserAgent({ board: createBoard(), player: BLACK, ai, fetchImpl: async (_url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    if (calls === 1) { assert.ok(payload.tools); return new Response('unsupported', { status: 422 }); }
    assert.equal(payload.tools, undefined);
    return reply({ content: JSON.stringify({ x: 7, y: 7, explanation: `中心布局 ${ai.apiKey}` }) });
  } });
  assert.equal(calls, 2); assert.equal(result.agent.source, 'remote');
  assert.equal(result.analysis.coach, '中心布局 [已隐藏密钥]');
  assert.equal(JSON.stringify(result).includes(ai.apiKey), false);
});

test('illegal coordinates and unproductive tool calls fall back, with no more than three requests', async () => {
  for (const invalid of [{ x: -1, y: 7 }, { x: 15, y: 1 }, { x: 2.5, y: 2 }, { x: 0, y: 0 }]) {
    const result = await runBrowserAgent({ board: createBoard(), player: BLACK, ai, fetchImpl: async () => reply({ content: JSON.stringify({ ...invalid, explanation: '无效落点' }) }) });
    assert.equal(result.agent.fallback, true);
    assert.deepEqual([result.move.x, result.move.y], [7, 7]);
  }
  let calls = 0;
  const result = await runBrowserAgent({ board: createBoard(), player: BLACK, ai, fetchImpl: async () => { calls++; return reply({ tool_calls: [tool('inspect_board')] }); } });
  assert.equal(calls, 3); assert.equal(result.agent.fallback, true);
});

test('remote suggestions cannot override an immediate win or urgent defense', async () => {
  for (const threatPlayer of [BLACK, WHITE]) {
    const board = createBoard();
    for (const x of [4, 5, 6, 7]) board[7][x] = threatPlayer;
    const best = chooseMove(board, BLACK);
    const result = await runBrowserAgent({ board, player: BLACK, ai, fetchImpl: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      const candidate = input.candidates.at(-1);
      return reply({ content: JSON.stringify({ ...candidate, explanation: '尝试另外一个点。' }) });
    } });
    assert.deepEqual([result.move.x, result.move.y], [best.x, best.y]);
    assert.equal(result.agent.source, 'remote');
  }
});

test('analysis-only replies are accepted and terminal games make no remote request', async () => {
  const result = await runBrowserAgent({ board: createBoard(), player: BLACK, purpose: 'analyze', ai, fetchImpl: async () => reply({ content: '{"analysis":"当前局面均衡，优先建立棋子联系。"}' }) });
  assert.equal(result.agent.source, 'remote'); assert.match(result.analysis.coach, /局面均衡/);
  const board = createBoard(); for (let x = 0; x < 5; x++) board[0][x] = BLACK;
  let calls = 0;
  const terminal = await runBrowserAgent({ board, player: WHITE, ai, fetchImpl: () => { calls++; } });
  assert.equal(calls, 0); assert.equal(terminal.move, null); assert.equal(terminal.analysis.recommendation, null);
});

test('invalid endpoints, oversized streams, and cancelled requests safely fall back', async () => {
  let calls = 0;
  for (const baseUrl of ['http://models.example/v1', 'https://user:pass@models.example/v1', 'https://models.example/v1?key=hidden']) {
    const result = await runBrowserAgent({ board: createBoard(), player: BLACK, ai: { ...ai, baseUrl }, fetchImpl: () => { calls++; } });
    assert.equal(result.agent.fallback, true); assert.match(result.agent.message, /HTTPS/);
  }
  assert.equal(calls, 0);
  const tooBig = await runBrowserAgent({ board: createBoard(), player: BLACK, ai, fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  assert.equal(tooBig.agent.fallback, true);
  const controller = new AbortController(); controller.abort();
  const stopped = await runBrowserAgent({ board: createBoard(), player: BLACK, ai, signal: controller.signal, fetchImpl: () => { calls++; } });
  assert.equal(calls, 0); assert.match(stopped.agent.message, /取消/);
});
