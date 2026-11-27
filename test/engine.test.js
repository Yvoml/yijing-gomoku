import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SIZE, BLACK, WHITE, createBoard, boardFromMoves, getWinner, isDraw, chooseMove, analyzePosition, analyzeMove } from '../lib/engine.js';

function line(board, points, player = BLACK) {
  for (const [x, y] of points) board[y][x] = player;
  return board;
}

test('coaching coordinates match the visible board after column H', () => {
  const board = line(createBoard(), [[4,7],[5,7],[6,7],[7,7]]);
  board[7][3] = WHITE;
  const position = analyzePosition(board, BLACK);
  assert.equal(position.recommendation.x, 8);
  assert.match(position.summary, /J8/);
  assert.ok(position.threats.some(threat => threat.x === 8 && threat.label.includes('J8')));
  assert.match(analyzeMove(board, {x:0,y:0,player:BLACK}).explanation, /J8/);
});

test('creates independent rows and reconstructs legal moves', () => {
  const board = createBoard();
  assert.equal(board.length, SIZE);
  board[0][0] = BLACK;
  assert.equal(board[1][0], 0);
  assert.equal(boardFromMoves([{ x: 7, y: 7, player: BLACK }])[7][7], BLACK);
  assert.throws(() => boardFromMoves([{ x: 15, y: 0, player: BLACK }]), /超出/);
  assert.throws(() => boardFromMoves([{ x: 0, y: 0, player: BLACK }, { x: 0, y: 0, player: WHITE }]), /重复/);
});

test('recognizes horizontal, vertical, both diagonals and overlines at edges', () => {
  for (const [dx, dy, startX, startY] of [[1, 0, 0, 0], [0, 1, 14, 0], [1, 1, 0, 0], [1, -1, 0, 14]]) {
    const board = createBoard();
    for (let i = 0; i < 5; i++) board[startY + dy * i][startX + dx * i] = BLACK;
    assert.equal(getWinner(board, startX, startY), BLACK);
    assert.equal(getWinner(board), BLACK);
    assert.equal(isDraw(board), false);
  }
  const overline = line(createBoard(), Array.from({ length: 6 }, (_, i) => [i, 7]), WHITE);
  assert.equal(getWinner(overline, 2, 7), WHITE);
  assert.equal(getWinner(createBoard(), 7, 7), null);
});

test('takes an immediate win before blocking an opponent', () => {
  const board = line(createBoard(), [[0, 0], [1, 0], [2, 0], [3, 0]], BLACK);
  line(board, [[5, 5], [6, 5], [7, 5], [8, 5]], WHITE);
  const move = chooseMove(board, BLACK);
  assert.deepEqual({ x: move.x, y: move.y }, { x: 4, y: 0 });
  assert.match(move.reason, /赢/);
});

test('blocks an edge four and a broken diagonal four', () => {
  const board = line(createBoard(), [[0, 0], [1, 0], [2, 0], [3, 0]], WHITE);
  let move = chooseMove(board, BLACK);
  assert.equal(move.x, 4);
  assert.equal(move.y, 0);
  const diagonal = line(createBoard(), [[2, 2], [3, 3], [5, 5], [6, 6]], WHITE);
  move = chooseMove(diagonal, BLACK);
  assert.equal(move.x, 4);
  assert.equal(move.y, 4);
});

test('never mutates input while choosing or analyzing, and is deterministic', () => {
  const board = boardFromMoves([
    { x: 7, y: 7, player: BLACK }, { x: 8, y: 7, player: WHITE },
    { x: 7, y: 8, player: BLACK }, { x: 8, y: 8, player: WHITE },
  ]);
  const snapshot = structuredClone(board);
  const best = chooseMove(board, BLACK);
  assert.deepEqual(chooseMove(board, BLACK), best);
  const analysis = analyzePosition(board, BLACK);
  const evaluation = analyzeMove(board, { x: best.x, y: best.y, player: BLACK });
  assert.equal(evaluation.quality, 'excellent');
  assert.ok(analysis.score >= -100 && analysis.score <= 100);
  assert.deepEqual(board, snapshot);
});

test('coach detects missed wins and urgent defense failures', () => {
  const attacking = line(createBoard(), [[0, 0], [1, 0], [2, 0], [3, 0]], BLACK);
  assert.equal(analyzeMove(attacking, { x: 9, y: 9, player: BLACK }).quality, 'mistake');
  const defending = line(createBoard(), [[0, 0], [1, 0], [2, 0], [3, 0]], WHITE);
  const bad = analyzeMove(defending, { x: 9, y: 9, player: BLACK });
  assert.equal(bad.quality, 'mistake');
  assert.match(bad.explanation, /封堵/);
  const analysis = analyzePosition(defending, BLACK);
  assert.equal(analysis.advantage, 'white');
  assert.ok(analysis.threats.some(threat => threat.type === 'win' && threat.player === WHITE));
});

test('handles empty and completed boards', () => {
  assert.equal(chooseMove(createBoard(), BLACK).x, 7);
  assert.equal(chooseMove(createBoard(), BLACK).y, 7);
  const won = line(createBoard(), [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], WHITE);
  assert.equal(chooseMove(won, BLACK), null);
  assert.equal(analyzePosition(won, BLACK).score, -100);
  assert.equal(analyzePosition(won, BLACK).recommendation, null);
  // Repeated pairs alternate by row, preventing every 5-stone run.
  const full = Array.from({ length: SIZE }, (_, y) => Array.from({ length: SIZE }, (_, x) => (Math.floor(x / 2) + y) % 2 + 1));
  assert.equal(getWinner(full), null);
  assert.equal(isDraw(full), true);
  assert.equal(chooseMove(full, BLACK), null);
});

test('standard search remains bounded on a dispersed middle game', () => {
  const board = createBoard();
  for (let y = 2; y < 14; y += 3) {
    for (let x = 2; x < 14; x += 3) board[y][x] = (x + y) % 2 + 1;
  }
  const started = performance.now();
  const move = chooseMove(board, BLACK);
  const duration = performance.now() - started;
  assert.ok(move && board[move.y][move.x] === 0);
  assert.ok(duration < 2000, `Bounded search took ${duration.toFixed(0)} ms`);
});
