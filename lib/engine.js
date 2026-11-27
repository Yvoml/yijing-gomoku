/**
 * Deterministic freestyle Gomoku engine. Five or more stones wins; there are no
 * Renju forbidden moves. Pattern scoring and a bounded tactical lookahead make
 * this useful as a local opponent/coach, but it is not a solved-game engine.
 * Functions never mutate the caller's board. Coordinates are zero based.
 */
export const SIZE = 15;
export const BLACK = 1;
export const WHITE = 2;

const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const WIN = 10_000_000;
const OPEN_FOUR = 300_000;
const FOUR = 45_000;
const OPEN_THREE = 6_000;
const inside = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;
const other = player => 3 - player;

export function createBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== SIZE || board.some(row =>
    !Array.isArray(row) || row.length !== SIZE || row.some(cell => ![0, BLACK, WHITE].includes(cell)))) {
    throw new TypeError('棋盘必须为 15 × 15 数组，棋子值为 0、1 或 2。');
  }
}

function validatePlayer(player) {
  if (player !== BLACK && player !== WHITE) throw new TypeError('棋子颜色必须为 1 或 2。');
}

export function boardFromMoves(moves) {
  if (!Array.isArray(moves)) throw new TypeError('棋谱必须为数组。');
  const board = createBoard();
  for (const move of moves) {
    if (!move || !Number.isInteger(move.x) || !Number.isInteger(move.y) || !inside(move.x, move.y)) {
      throw new RangeError('落子位置超出棋盘。');
    }
    validatePlayer(move.player);
    if (board[move.y][move.x] !== 0) throw new Error('同一位置不能重复落子。');
    board[move.y][move.x] = move.player;
  }
  return board;
}

/** With coordinates, checks the last move; without them, scans the board. */
export function getWinner(board, x, y) {
  if (x === undefined || y === undefined) {
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        if (board[row][col] && winnerAt(board, col, row)) return board[row][col];
      }
    }
    return null;
  }
  return inside(x, y) ? winnerAt(board, x, y) : null;
}

function winnerAt(board, x, y) {
  const player = board[y][x];
  if (!player) return null;
  for (const [dx, dy] of DIRECTIONS) {
    let count = 1;
    for (const sign of [-1, 1]) {
      let nx = x + dx * sign;
      let ny = y + dy * sign;
      while (inside(nx, ny) && board[ny][nx] === player) {
        count++;
        nx += dx * sign;
        ny += dy * sign;
      }
    }
    if (count >= 5) return player;
  }
  return null;
}

export function isDraw(board) {
  return board.every(row => row.every(Boolean)) && getWinner(board) === null;
}

function candidates(board, radius = 2) {
  const occupied = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) if (board[y][x]) occupied.push({ x, y });
  }
  if (!occupied.length) return [{ x: 7, y: 7 }];
  const seen = new Set();
  const result = [];
  for (const stone of occupied) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = stone.x + dx;
        const y = stone.y + dy;
        const key = y * SIZE + x;
        if (inside(x, y) && !board[y][x] && !seen.has(key)) {
          seen.add(key);
          result.push({ x, y });
        }
      }
    }
  }
  return result;
}

function containsAtCenter(line, pattern) {
  let start = line.indexOf(pattern);
  while (start >= 0) {
    if (start <= 5 && start + pattern.length > 5 && pattern[5 - start] === 'X') return true;
    start = line.indexOf(pattern, start + 1);
  }
  return false;
}

function pointScore(board, x, y, player) {
  if (board[y][x]) return -Infinity;
  let total = 0;
  let fours = 0;
  let threes = 0;
  for (const [dx, dy] of DIRECTIONS) {
    let line = '';
    for (let step = -5; step <= 5; step++) {
      const nx = x + step * dx;
      const ny = y + step * dy;
      line += step === 0 ? 'X' : !inside(nx, ny) ? '#' : board[ny][nx] === player ? 'X' : board[ny][nx] ? '#' : '.';
    }
    if (containsAtCenter(line, 'XXXXX')) return WIN;
    let value = 0;
    if (containsAtCenter(line, '.XXXX.')) value = OPEN_FOUR;
    for (let start = 1; start <= 5; start++) {
      const window = line.slice(start, start + 5);
      if (!window.includes('#')) {
        const stones = [...window].filter(cell => cell === 'X').length;
        if (stones === 4) value = Math.max(value, FOUR);
        if (stones === 3) value = Math.max(value, 900);
        if (stones === 2) value = Math.max(value, 45);
        if (stones === 1) value = Math.max(value, 4);
      }
    }
    if (['.XXX.', '.XX.X.', '.X.XX.'].some(pattern => containsAtCenter(line, pattern))) value = Math.max(value, OPEN_THREE);
    if (['.XX.', '.X.X.'].some(pattern => containsAtCenter(line, pattern))) value = Math.max(value, 300);
    total += value;
    if (value >= FOUR) fours++;
    if (value >= OPEN_THREE && value < FOUR) threes++;
  }
  if (fours >= 2) total += 180_000;
  else if (fours && threes) total += 90_000;
  else if (threes >= 2) total += 24_000;
  return total;
}

function rankMoves(board, player) {
  return candidates(board).map(({ x, y }) => {
    const attack = pointScore(board, x, y, player);
    const defense = pointScore(board, x, y, other(player));
    const centrality = 7 - (Math.abs(x - 7) + Math.abs(y - 7)) / 2;
    return { x, y, attack, defense, score: attack + defense * 1.08 + centrality };
  }).sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
}

function reasonFor(move, player) {
  if (move.attack >= WIN) return '立即连成五子，赢下对局。';
  if (move.defense >= WIN) return '封堵对手的成五点，避免下一手失利。';
  if (move.fork) return '形成两个成五点，对手难以同时防守。';
  if (move.attack >= OPEN_FOUR) return '形成活四，迫使对手立即应对。';
  if (move.defense >= OPEN_FOUR) return '提前压制对手的活四威胁。';
  if (move.attack >= FOUR) return '制造冲四，争取进攻主动权。';
  if (move.defense >= FOUR) return '防守对手的冲四或多方向威胁。';
  if (move.attack >= OPEN_THREE) return '延展活三，建立后续进攻空间。';
  if (move.defense >= OPEN_THREE) return '限制对手的活三发展，同时保持联系。';
  return player === BLACK ? '靠近已有棋子布局，兼顾中心和后续连接。' : '保持棋子联系，兼顾防守与后续发展。';
}

function publicMove(move, player) {
  return { x: move.x, y: move.y, score: Math.round(move.score), reason: reasonFor(move, player) };
}

/**
 * Always takes an immediate win before defending. Standard/hard add a bounded
 * reply search; easy uses pattern ordering. Equal positions use a stable order.
 * Returns null when the position already ended or no legal move remains.
 */
export function chooseMove(board, player, { difficulty = 'standard' } = {}) {
  validateBoard(board);
  validatePlayer(player);
  if (getWinner(board)) return null;
  const ranked = rankMoves(board, player);
  if (!ranked.length) return null;
  const wins = ranked.filter(move => move.attack >= WIN);
  const blocks = ranked.filter(move => move.defense >= WIN);
  let options = wins.length ? wins : blocks.length ? blocks : ranked;
  if (!wins.length && !blocks.length && difficulty !== 'easy' && difficulty !== 'beginner') {
    const copy = board.map(row => [...row]);
    const width = difficulty === 'hard' ? 16 : 10;
    options = ranked.slice(0, width).map(move => {
      copy[move.y][move.x] = player;
      const replies = rankMoves(copy, other(player));
      const winningPoints = replies.filter(reply => reply.defense >= WIN);
      let score = move.score;
      let fork = false;
      if (winningPoints.length >= 2) {
        score += 2_000_000;
        fork = true;
      } else if (winningPoints.length === 1) {
        // A single immediate threat forces the opponent's next placement.
        const forced = winningPoints[0];
        copy[forced.y][forced.x] = other(player);
        const continuation = rankMoves(copy, player)[0];
        score += (continuation?.attack ?? 0) * 0.25;
        copy[forced.y][forced.x] = 0;
      } else if (replies.length) {
        const reply = replies[0];
        score -= reply.attack * 0.55;
        copy[reply.y][reply.x] = other(player);
        const continuation = rankMoves(copy, player)[0];
        score += (continuation?.attack ?? 0) * 0.18;
        copy[reply.y][reply.x] = 0;
      }
      copy[move.y][move.x] = 0;
      return { ...move, score, fork };
    }).sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  }
  const best = options[0];
  return {
    ...publicMove(best, player),
    alternatives: options.slice(1, 4).map(move => publicMove(move, player)),
  };
}

// Match the UI's Go-style columns (I is skipped to avoid confusing it with 1).
const coordinate = ({ x, y }) => `${'ABCDEFGHJKLMNOP'[x]}${SIZE - y}`;

/** Position score is black-positive, from -100 (white wins) to 100. */
export function analyzePosition(board, player) {
  validateBoard(board);
  validatePlayer(player);
  const winner = getWinner(board);
  if (winner) return {
    score: winner === BLACK ? 100 : -100,
    advantage: winner === BLACK ? 'black' : 'white',
    summary: `${winner === BLACK ? '黑' : '白'}方已连成五子，对局结束。`,
    threats: [], recommendation: null,
  };
  const ranked = rankMoves(board, BLACK);
  if (!ranked.length) return { score: 0, advantage: 'balanced', summary: '棋盘已满，本局和棋。', threats: [], recommendation: null };
  const strongestBlack = Math.max(...ranked.map(move => move.attack));
  const strongestWhite = Math.max(...ranked.map(move => move.defense));
  const raw = (strongestBlack - strongestWhite) / (Math.max(strongestBlack, strongestWhite) + 12_000);
  const score = Math.round(Math.max(-95, Math.min(95, raw * 95)));
  const advantage = score > 12 ? 'black' : score < -12 ? 'white' : 'balanced';
  const threats = [];
  for (const move of ranked) {
    for (const [color, strength] of [[BLACK, move.attack], [WHITE, move.defense]]) {
      if (strength >= OPEN_THREE) threats.push({
        x: move.x, y: move.y, player: color,
        type: strength >= WIN ? 'win' : strength >= FOUR ? 'four' : 'three',
        label: `${color === BLACK ? '黑' : '白'}方在 ${coordinate(move)} ${strength >= WIN ? '可立即成五' : strength >= FOUR ? '可形成四子威胁' : '可发展活三'}`,
        strength,
      });
    }
  }
  threats.sort((a, b) => b.strength - a.strength);
  const recommendation = chooseMove(board, player);
  const lead = advantage === 'balanced' ? '局面暂时均衡。' : `${advantage === 'black' ? '黑' : '白'}方当前威胁更强。`;
  const summary = `${lead}${recommendation ? `建议落在 ${coordinate(recommendation)}：${recommendation.reason}` : ''}本地评估为启发式判断。`;
  return { score, advantage, summary, threats: threats.slice(0, 6), recommendation };
}

export function analyzeMove(boardBefore, move) {
  validateBoard(boardBefore);
  if (!move || !Number.isInteger(move.x) || !Number.isInteger(move.y) || !inside(move.x, move.y)) throw new RangeError('落子位置超出棋盘。');
  validatePlayer(move.player);
  if (boardBefore[move.y][move.x]) throw new Error('该位置已有棋子。');
  const bestMove = chooseMove(boardBefore, move.player);
  if (!bestMove) return { quality: 'good', scoreLoss: 0, explanation: '当前对局已经结束。', bestMove: null };
  const ranked = rankMoves(boardBefore, move.player);
  const selected = ranked.find(candidate => candidate.x === move.x && candidate.y === move.y) ?? {
    x: move.x, y: move.y,
    attack: pointScore(boardBefore, move.x, move.y, move.player),
    defense: pointScore(boardBefore, move.x, move.y, other(move.player)),
    score: 0,
  };
  const winningMove = selected.attack >= WIN;
  const missedWin = ranked.some(candidate => candidate.attack >= WIN) && !winningMove;
  const failedDefense = !winningMove && ranked.some(candidate => candidate.defense >= WIN) && selected.defense < WIN;
  const isBest = bestMove.x === move.x && bestMove.y === move.y;
  const heuristicBest = Math.max(...ranked.map(candidate => candidate.score));
  const relativeLoss = Math.max(0, (heuristicBest - selected.score) / Math.max(heuristicBest, 1));
  let quality;
  let explanation;
  if (missedWin) {
    quality = 'mistake';
    explanation = `错过了 ${coordinate(bestMove)} 的直接成五机会。`;
  } else if (failedDefense) {
    quality = 'mistake';
    explanation = `未封堵对手的成五点；应优先考虑 ${coordinate(bestMove)}。`;
  } else if (winningMove || isBest) {
    quality = 'excellent';
    explanation = winningMove ? '准确抓住成五机会。' : `这一步符合当前局面的主要需求。${bestMove.reason}`;
  } else if (relativeLoss < 0.35) {
    quality = 'good';
    explanation = '这一步保持了局面的主要联系，进攻和防守较为合理。';
  } else if (relativeLoss < 0.8 || heuristicBest < OPEN_THREE) {
    quality = 'inaccuracy';
    explanation = `这一步效率略低；${coordinate(bestMove)} 能更好地${bestMove.reason.replace(/。$/, '')}`;
  } else {
    quality = 'mistake';
    explanation = `忽略了较强的局部机会或威胁，建议考虑 ${coordinate(bestMove)}。${bestMove.reason}`;
  }
  return {
    quality,
    scoreLoss: missedWin || failedDefense ? 100 : Math.round(relativeLoss * 100),
    explanation,
    bestMove,
  };
}
