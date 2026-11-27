const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const SIZE = 15, ORIGIN = 30, STEP = 600 / 14;
const LETTERS = 'ABCDEFGHJKLMNOP';
const DIFFICULTY = { easy: '入门', standard: '标准', hard: '进阶' };
const QUALITY = { excellent: '妙手', good: '稳健', inaccuracy: '值得推敲', mistake: '需要留意' };
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="m8 4-5 5 5 5M3 9h11a7 7 0 0 1 0 14"/>',
  bulb: '<path d="M9 18h6m-6 3h6M8 14a7 7 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z"/>',
  chart: '<path d="M4 4v16h16M8 15l4-5 4 2 4-7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  sparkle: '<path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8L12 2ZM20 2v4m-2-2h4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  first: '<path d="M6 5v14m13-14-9 7 9 7Z"/>',
  prev: '<path d="m15 5-9 7 9 7"/>',
  next: '<path d="m9 5 9 7-9 7"/>',
  last: '<path d="M18 5v14M5 5l9 7-9 7Z"/>'
};
$$('[data-icon]').forEach(element => { element.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[element.dataset.icon] || ''}</svg>`; });

let game = null;
let analysis = null;
let busy = false;
let replayAt = null;
let selected = { x: 7, y: 7 };
let showFocus = false;
let hintVisible = false;
let toastTimer;
let serverAI = { configured: false, model: '' };
// Keys are intentionally kept only in this module's memory, never in web storage.
let provider = null;
let forceLocal = false;

function loadPreference(key, fallback = null) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function savePreference(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* Storage can be disabled; the app still works. */ }
}
function coord(move) { return move && Number.isInteger(move.x) && Number.isInteger(move.y) ? `${LETTERS[move.x]}${15 - move.y}` : '—'; }
function announce(message) { $('#announcer').textContent = message; }
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5500);
}
function messageOf(error) { return error?.message || '请求未完成，请稍后重试。'; }
async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `请求失败（${response.status}）`);
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时。对局已保存，可重试或刷新恢复。');
    if (error instanceof TypeError) throw new Error('无法连接对局服务，请检查网络后重试。');
    throw error;
  } finally { clearTimeout(timeout); }
}
function aiBody() {
  if (forceLocal) return { ai: { disabled: true } };
  return provider ? { ai: { ...provider } } : {};
}
function displayedMoves() { return game?.moves.slice(0, replayAt === null ? undefined : replayAt) || []; }
function displayedBoard() {
  if (!game) return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  if (replayAt === null) return game.board;
  const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  displayedMoves().forEach(move => { board[move.y][move.x] = move.player; });
  return board;
}
function winningCells(board) {
  const cells = new Set();
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (!board[y][x]) continue;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const priorX = x - dx, priorY = y - dy;
      if (priorX >= 0 && priorX < SIZE && priorY >= 0 && priorY < SIZE && board[priorY][priorX] === board[y][x]) continue;
      const line = [];
      for (let i = 0; i < SIZE; i++) {
        const nx = x + dx * i, ny = y + dy * i;
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE || board[ny][nx] !== board[y][x]) break;
        line.push(`${nx},${ny}`);
      }
      if (line.length >= 5) line.forEach(cell => cells.add(cell));
    }
  }
  return cells;
}
function renderBoard() {
  const board = displayedBoard();
  const moves = displayedMoves();
  const last = moves.at(-1);
  const wins = winningCells(board);
  let markup = '<defs><radialGradient id="black-stone" cx="34%" cy="26%" r="75%"><stop offset="0" stop-color="#5b5e53"/><stop offset=".52" stop-color="#2a2e27"/><stop offset="1" stop-color="#161e19"/></radialGradient><radialGradient id="white-stone" cx="35%" cy="28%" r="75%"><stop offset="0" stop-color="#fffef6"/><stop offset=".65" stop-color="#f5f2df"/><stop offset="1" stop-color="#d7d6c4"/></radialGradient></defs>';
  for (let i = 0; i < SIZE; i++) {
    const p = ORIGIN + i * STEP;
    markup += `<path class="grid-line" d="M${ORIGIN} ${p}H630M${p} ${ORIGIN}V630"/>`;
  }
  for (const [x, y] of [[3,3],[11,3],[7,7],[3,11],[11,11]]) markup += `<circle class="star-point" cx="${ORIGIN + x * STEP}" cy="${ORIGIN + y * STEP}" r="3.5"/>`;
  for (let y = 0; y < SIZE; y++) {
    markup += '<g role="row">';
    for (let x = 0; x < SIZE; x++) {
      const cx = ORIGIN + x * STEP, cy = ORIGIN + y * STEP, value = board[y][x];
      markup += `<g role="gridcell" id="cell-${x}-${y}" aria-label="${coord({x,y})}，${value ? value === 1 ? '黑棋' : '白棋' : '空位'}" aria-selected="${selected.x === x && selected.y === y}"><rect x="${cx - STEP / 2}" y="${cy - STEP / 2}" width="${STEP}" height="${STEP}" fill="transparent"/>`;
      if (value) {
        markup += `<circle class="stone-shadow" cx="${cx}" cy="${cy}" r="18.4" fill="url(#${value === 1 ? 'black' : 'white'}-stone)" stroke="${value === 1 ? '#20271c' : '#d0c7ad'}" stroke-width=".8"/>`;
        if (wins.has(`${x},${y}`)) markup += `<circle cx="${cx}" cy="${cy}" r="21" fill="none" stroke="#b88b4b" stroke-width="2.4"/>`;
        if (last?.x === x && last?.y === y) markup += `<circle cx="${cx}" cy="${cy}" r="3.6" fill="${value === 1 ? '#dfc48d' : '#9d793f'}"/>`;
        if (replayAt !== null) {
          const number = moves.findIndex(move => move.x === x && move.y === y) + 1;
          markup += `<text x="${cx}" y="${cy + .5}" text-anchor="middle" dominant-baseline="middle" fill="${value === 1 ? '#f1e5c9' : '#6a6555'}" font-size="13" font-family="Arial,sans-serif">${number}</text>`;
        }
      }
      markup += '</g>';
    }
    markup += '</g>';
  }
  const recommendation = analysis?.recommendation;
  if (hintVisible && recommendation && !board[recommendation.y]?.[recommendation.x]) {
    const cx = ORIGIN + recommendation.x * STEP, cy = ORIGIN + recommendation.y * STEP;
    markup += `<circle cx="${cx}" cy="${cy}" r="17" fill="#78945d30" stroke="#6b8252" stroke-width="2" stroke-dasharray="3 3"/><path d="M${cx - 6} ${cy}h12M${cx} ${cy - 6}v12" stroke="#5f7847" stroke-width="1.5"/>`;
  }
  if (showFocus) {
    const cx = ORIGIN + selected.x * STEP, cy = ORIGIN + selected.y * STEP;
    markup += `<rect x="${cx - 21}" y="${cy - 21}" width="42" height="42" rx="5" fill="none" stroke="#727f57" stroke-width="2.5"/>`;
  }
  $('#board').innerHTML = markup;
  $('#board').setAttribute('aria-activedescendant', `cell-${selected.x}-${selected.y}`);
}
function gameStatus() {
  if (!game) return '准备中';
  if (game.status === 'won') return `${game.winner === 1 ? '黑棋' : '白棋'}获胜`;
  if (game.status === 'draw') return '和棋';
  return `${game.currentPlayer === 1 ? '黑棋' : '白棋'}落子`;
}
function render() {
  renderBoard();
  const replay = replayAt !== null;
  const moves = displayedMoves();
  const isAI = game?.mode !== 'local';
  $('#game-title').textContent = replay ? '棋谱复盘' : isAI ? '人机对弈' : '本地双人';
  $('#difficulty-tag').textContent = isAI ? DIFFICULTY[game?.difficulty] || '标准' : '自由对弈';
  $('#move-count').textContent = `第 ${moves.length} 手`;
  $('#save-status').textContent = game ? '已自动保存' : '准备中';
  $('#black-name').textContent = isAI ? game?.humanColor === 2 ? '弈境 AI · 黑棋' : '你 · 黑棋' : '棋友一 · 黑棋';
  $('#white-name').textContent = isAI ? game?.humanColor === 2 ? '你 · 白棋' : '弈境 AI · 白棋' : '棋友二 · 白棋';
  $('#black-subtitle').textContent = game?.status === 'won' && game.winner === 1 ? '五子连珠 · 获胜' : '先手';
  $('#white-subtitle').textContent = game?.status === 'won' && game.winner === 2 ? '五子连珠 · 获胜' : '后手';
  $('#black-player').classList.toggle('is-turn', !!game && game.status === 'active' && game.currentPlayer === 1 && !replay);
  $('#white-player').classList.toggle('is-turn', !!game && game.status === 'active' && game.currentPlayer === 2 && !replay);
  $('#session-mode').textContent = isAI ? '人机对弈' : '本地双人';
  $('#session-side').textContent = isAI ? `${game?.humanColor === 2 ? '白棋' : '黑棋'} / ${DIFFICULTY[game?.difficulty] || '标准'}` : '黑白轮流落子';
  $('#session-status').textContent = replay ? `复盘第 ${replayAt} 手` : gameStatus();
  $('#undo').disabled = busy || !game?.moves.length || replay;
  $('#hint').disabled = busy || !game || (!replay && game.status !== 'active');
  $('#analyze').disabled = busy || !game;
  $('#export').disabled = busy || !game;
  $('#new-game').disabled = busy;
  $('#replay-controls').hidden = !replay;
  $('#replay-slider').max = String(game?.moves.length || 0);
  $('#replay-slider').value = String(replayAt || 0);
  $('#replay-slider').disabled = busy;
  $('#replay-label').textContent = `${replayAt || 0} / ${game?.moves.length || 0} 手`;
  $('#replay-first').disabled = busy || !replayAt;
  $('#replay-prev').disabled = busy || !replayAt;
  $('#replay-next').disabled = busy || replayAt >= (game?.moves.length || 0);
  $('#replay-last').disabled = busy || replayAt >= (game?.moves.length || 0);
  $('#exit-replay').disabled = busy;
  if (game) {
    $('#export-sgf').href = `/api/games/${encodeURIComponent(game.id)}/export?format=sgf`;
    $('#export-json').href = `/api/games/${encodeURIComponent(game.id)}/export?format=json`;
  }
  const lastHumanMove = [...moves].reverse().find(move => move.explanation && (game?.mode !== 'ai' || move.player === game.humanColor));
  $('#move-feedback').hidden = !lastHumanMove;
  if (lastHumanMove) {
    $('#quality-badge').textContent = `第 ${lastHumanMove.number || game.moves.indexOf(lastHumanMove) + 1} 手 · ${coord(lastHumanMove)} · ${QUALITY[lastHumanMove.quality] || '落子观察'}`;
    $('#quality-text').textContent = lastHumanMove.explanation;
  }
  if (!analysis) {
    $('#advantage-label').textContent = game?.status === 'active' ? moves.length ? '等待分析' : '势均力敌' : gameStatus();
    $('#evaluation-fill').style.width = game?.status === 'won' ? game.winner === 1 ? '100%' : '0%' : '50%';
    $('#evaluation-caption').textContent = moves.length ? '点击分析，评估当前局势' : '本地引擎已就绪';
    $('#insight-title').textContent = game?.status === 'won' ? `${game.winner === 1 ? '黑棋' : '白棋'}，五子连珠。` : game?.status === 'draw' ? '一场势均力敌的较量。' : replay ? '回看每一步思考。' : moves.length ? '观察全局，再落一子。' : '好棋，始于从容思考。';
    $('#insight-text').textContent = game?.status !== 'active' && game ? '本局棋谱已保存。可以分析整盘对局，或导出棋谱，回看关键的得失。' : replay ? '拖动手数或使用前后按钮逐手复盘；点击「分析棋局」查看这一刻的局势。' : moves.length ? `当前轮到${game.currentPlayer === 1 ? '黑棋' : '白棋'}。关注对手的连续棋形，同时为自己的进攻留出空间。` : '在棋盘上落下第一子。每一步都会自动保存，点击「落子提示」可获得局面建议。';
    $('#recommendation-coordinate').textContent = '—';
    $('#recommendation-reason').textContent = '点击「落子提示」，寻找下一步';
    $('#threat-list').hidden = true;
  }
  updateEngineLabel();
}
function updateEngineLabel() {
  const remote = !forceLocal && (provider || serverAI.configured);
  $('#engine-badge').textContent = remote ? 'AI AGENT' : 'LOCAL';
  $('#connection-label').textContent = game ? '对局服务已连接' : '正在连接';
  $('#settings-state').textContent = provider ? `当前使用：${provider.model || '自定义模型'}。密钥在刷新或关闭页面后清除。` : forceLocal ? '当前使用内置本地引擎，无需密钥。' : serverAI.configured ? `服务端已配置 AI${serverAI.model ? `：${serverAI.model}` : ''}，也可以填写自己的服务商。` : '当前使用内置本地引擎，连接 AI 服务后可获取模型讲解。';
}
function renderAnalysis(result) {
  if (!result) return;
  analysis = result;
  const score = Number(result.score) || 0;
  const blackPercent = result.advantage === 'balanced' ? 50 : result.advantage === 'black' ? 65 + Math.min(28, Math.log10(Math.abs(score) + 1) * 5) : 35 - Math.min(28, Math.log10(Math.abs(score) + 1) * 5);
  $('#evaluation-fill').style.width = `${blackPercent}%`;
  $('#advantage-label').textContent = ({black:'黑棋占优',white:'白棋占优',balanced:'势均力敌'})[result.advantage] || '局势观察';
  $('#evaluation-caption').textContent = replayAt === null ? `第 ${game?.moves.length || 0} 手局势 · 非胜率` : `复盘第 ${replayAt} 手 · 非胜率`;
  $('#insight-title').textContent = result.advantage === 'balanced' ? '攻守之间，尚有余地。' : result.advantage === 'black' ? '黑棋掌握更多主动。' : '白棋掌握更多主动。';
  $('#insight-text').textContent = result.coach || result.summary || '关注双方威胁，优先处理直接成五的落点。';
  $('#recommendation-coordinate').textContent = coord(result.recommendation);
  $('#recommendation-reason').textContent = result.recommendation?.reason || (result.recommendation ? '结合当前局势的候选落点' : '本局已结束，可复盘关键落子');
  const threats = Array.isArray(result.threats) ? result.threats.slice(0, 4) : [];
  $('#threat-list').replaceChildren();
  threats.forEach(threat => {
    const tag = document.createElement('span');
    tag.textContent = typeof threat === 'string' ? threat : threat.description || threat.summary || threat.label || threat.type || threat.reason || '注意棋形威胁';
    $('#threat-list').append(tag);
  });
  $('#threat-list').hidden = !threats.length;
  renderBoard();
}
function renderAgent(agent) {
  if (!agent) return;
  $('#coach-notice > span:last-child').textContent = agent.message || (agent.source === 'remote' ? 'AI Agent 已结合棋盘工具完成分析。' : '由本地棋力引擎分析，建议仅供参考。');
  if (agent.source) $('#engine-badge').textContent = agent.source === 'remote' ? 'AI AGENT' : 'LOCAL';
  const steps = Array.isArray(agent.steps) ? agent.steps : [];
  $('#agent-steps').replaceChildren();
  steps.forEach(step => {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = step.tool || step.name || '棋盘分析';
    const description = document.createElement('span');
    description.textContent = step.summary || step.description || (typeof step === 'string' ? step : '完成');
    item.append(title, description);
    $('#agent-steps').append(item);
  });
  $('#agent-trace').hidden = !steps.length;
  if (agent.fallback) toast('AI 服务暂不可用，已由本地引擎继续。');
}
function acceptGame(value, extraAnalysis) {
  game = value;
  analysis = null;
  hintVisible = false;
  savePreference('gomoku.currentGame', game.id);
  render();
  if (extraAnalysis) renderAnalysis(extraAnalysis);
}
function setBusy(value, label = '正在处理') {
  busy = value;
  $('#board-overlay').hidden = !value;
  $('#board-overlay-text').textContent = label;
  $('#board').setAttribute('aria-busy', String(value));
  render();
}
async function runAction(label, task) {
  if (busy) return;
  setBusy(true, label);
  try { await task(); } catch (error) { toast(messageOf(error)); } finally { setBusy(false); }
}
async function maybeAgent() {
  if (!game || game.mode !== 'ai' || game.status !== 'active' || game.currentPlayer === game.humanColor || replayAt !== null) return;
  $('#board-overlay-text').textContent = 'AI 正在思考';
  await new Promise(resolve => requestAnimationFrame(resolve));
  const result = await api(`/api/games/${encodeURIComponent(game.id)}/agent`, aiBody());
  acceptGame(result.game, result.analysis);
  renderAgent(result.agent);
  const move = game.moves.at(-1);
  announce(`AI 落子 ${coord(move)}。${gameStatus()}。`);
  if (game.status !== 'active') toast(`${gameStatus()}，棋谱已保存。`);
}
async function placeMove(x, y) {
  if (busy || !game || replayAt !== null) return;
  if (game.status !== 'active') { toast('本局已结束。可开启新对局或回看棋谱。'); return; }
  if (game.mode === 'ai' && game.currentPlayer !== game.humanColor) { await runAction('AI 正在思考', maybeAgent); return; }
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || game.board[y][x]) return;
  await runAction('正在保存落子', async () => {
    const result = await api(`/api/games/${encodeURIComponent(game.id)}/moves`, {x, y});
    acceptGame(result.game, result.analysis);
    announce(`${coord({x,y})} 已落子。${gameStatus()}。`);
    if (game.status !== 'active') toast(`${gameStatus()}，棋谱已保存。`);
    await maybeAgent();
  });
}

$('#board').addEventListener('click', event => {
  const rect = $('#board').getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width * 660 - ORIGIN) / STEP);
  const y = Math.round(((event.clientY - rect.top) / rect.height * 660 - ORIGIN) / STEP);
  showFocus = false;
  if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) { selected = {x, y}; placeMove(x, y); }
});
$('#board').addEventListener('keydown', event => {
  const delta = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] }[event.key];
  if (delta) {
    event.preventDefault();
    selected = {x:Math.max(0,Math.min(14, selected.x + delta[0])),y:Math.max(0,Math.min(14,selected.y + delta[1]))};
    showFocus = true;
    renderBoard();
    announce(`${coord(selected)}，${displayedBoard()[selected.y][selected.x] ? '已有棋子' : '空位'}`);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault(); placeMove(selected.x, selected.y);
  }
});
$('#board').addEventListener('blur', () => { showFocus = false; renderBoard(); });
$('.top-coordinates').innerHTML = [...LETTERS].map(letter => `<span>${letter}</span>`).join('');
$('.left-coordinates').innerHTML = Array.from({length:15},(_,index)=>`<span>${15-index}</span>`).join('');
function layoutCoordinates() {
  const boardRect = $('#board').getBoundingClientRect();
  const areaRect = $('.board-area').getBoundingClientRect();
  for (const selector of ['.top-coordinates', '.left-coordinates']) {
    const root = $(selector);
    Object.assign(root.style, {left:'0px',top:'0px',right:'auto',bottom:'auto',display:'block',transform:'none'});
    [...root.children].forEach((label, index) => {
      const offset = (ORIGIN + index * STEP) / 660 * boardRect.width;
      Object.assign(label.style, {
        position:'absolute',transform:'translate(-50%, -50%)',
        left:`${selector === '.top-coordinates' ? boardRect.left - areaRect.left + offset : boardRect.left - areaRect.left - 20}px`,
        top:`${selector === '.top-coordinates' ? boardRect.top - areaRect.top - 17 : boardRect.top - areaRect.top + offset}px`
      });
    });
  }
}
new ResizeObserver(layoutCoordinates).observe($('.board-area'));
requestAnimationFrame(layoutCoordinates);

$('#new-game').addEventListener('click', () => $('#new-dialog').showModal());
$$('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
$$('input[name="mode"]').forEach(input => input.addEventListener('change', () => {
  const local = $('#new-form input[name="mode"]:checked').value === 'local';
  $('#ai-game-options').disabled = local;
  $('#ai-game-options').classList.toggle('form-disabled', local);
}));
$('#new-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const form = new FormData(event.currentTarget);
  $('#new-dialog').close();
  await runAction('正在创建新对局', async () => {
    const result = await api('/api/games', {mode:form.get('mode'),difficulty:form.get('difficulty') || 'standard',humanColor:Number(form.get('humanColor') || 1)});
    replayAt = null;
    acceptGame(result.game, result.analysis);
    $('#agent-trace').hidden = true;
    $('#coach-notice > span:last-child').textContent = '新对局已保存。落子后可随时获得提示与分析。';
    await maybeAgent();
    announce('新对局已开启。');
  });
});
$('#undo').addEventListener('click', () => runAction('正在回退棋步', async () => {
  const result = await api(`/api/games/${encodeURIComponent(game.id)}/undo`, {});
  acceptGame(result.game, result.analysis);
  toast('已悔棋，当前局面已保存。');
  await maybeAgent();
}));
async function requestAnalysis(isHint) {
  await runAction(isHint ? '正在寻找好棋' : '正在分析棋局', async () => {
    const body = {...aiBody(),...(replayAt === null ? {} : {moveNumber:replayAt})};
    const endpoint = isHint && replayAt === null ? 'hint' : 'analyze';
    const result = await api(`/api/games/${encodeURIComponent(game.id)}/${endpoint}`, body);
    hintVisible = isHint;
    renderAnalysis(result.analysis);
    renderAgent(result.agent);
    if (isHint && result.analysis?.recommendation) announce(`推荐落子 ${coord(result.analysis.recommendation)}。${result.analysis.recommendation.reason || ''}`);
  });
}
$('#hint').addEventListener('click', () => requestAnalysis(true));
$('#analyze').addEventListener('click', () => requestAnalysis(false));
$('#export').addEventListener('click', () => {
  const hidden = !$('#export-menu').hidden;
  $('#export-menu').hidden = hidden;
  $('#export').setAttribute('aria-expanded', String(!hidden));
});
document.addEventListener('click', event => {
  if (!event.target.closest('.export-wrap')) {
    $('#export-menu').hidden = true;
    $('#export').setAttribute('aria-expanded', 'false');
  }
});
$('#nav-settings').addEventListener('click', () => {
  $('#ai-base-url').value = provider?.baseUrl || loadPreference('gomoku.aiBaseUrl', '');
  $('#ai-model').value = provider?.model || loadPreference('gomoku.aiModel', '');
  $('#ai-api-key').value = provider?.apiKey || '';
  updateEngineLabel();
  $('#settings-dialog').showModal();
});
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  const baseUrl = $('#ai-base-url').value.trim();
  const model = $('#ai-model').value.trim();
  const apiKey = $('#ai-api-key').value.trim();
  if (!baseUrl || !model || !apiKey) { toast('请完整填写 API 地址、模型名称和密钥，或选择使用本地引擎。'); return; }
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    if (url.username || url.password || url.search || url.hash) throw new Error();
  } catch { toast('请输入有效的 HTTP(S) API Base URL，不包含密钥、查询参数或片段。'); return; }
  provider = {baseUrl:baseUrl.replace(/\/+$/, ''),model,apiKey};
  forceLocal = false;
  savePreference('gomoku.aiBaseUrl', provider.baseUrl);
  savePreference('gomoku.aiModel', model);
  $('#settings-dialog').close();
  $('#coach-notice > span:last-child').textContent = '自定义 AI 已设置。下一次 AI 落子或分析时生效，连接失败会回退本地引擎。';
  updateEngineLabel();
  toast('AI 设置已保存至本次页面会话。');
});
$('#clear-ai').addEventListener('click', () => {
  provider = null;
  forceLocal = true;
  $('#ai-api-key').value = '';
  $('#settings-dialog').close();
  $('#coach-notice > span:last-child').textContent = '已切换为本地引擎，无需 API 密钥即可对弈和分析。';
  updateEngineLabel();
  toast('已使用本地引擎。');
});

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}
async function openHistory() {
  $('#history-dialog').showModal();
  $('#history-list').replaceChildren();
  const loading = document.createElement('div'); loading.className = 'loading-empty'; loading.textContent = '正在读取你的棋谱…'; $('#history-list').append(loading);
  try {
    const result = await api('/api/games');
    $('#history-list').replaceChildren();
    if (!result.games?.length) {
      const empty = document.createElement('p'); empty.className = 'empty-history'; empty.textContent = '第一盘棋，正等着你。开启新对局后，棋谱会自动出现在这里。'; $('#history-list').append(empty); return;
    }
    result.games.forEach(item => {
      const row = document.createElement('article'); row.className = 'history-item';
      const info = document.createElement('div');
      const title = document.createElement('h3'); title.textContent = item.title || `${item.mode === 'ai' ? '人机对弈' : '本地双人'} · ${formatDate(item.createdAt)}`;
      const meta = document.createElement('p');
      const status = item.status === 'active' ? '进行中' : item.status === 'draw' ? '和棋' : `${item.winner === 1 ? '黑棋' : '白棋'}获胜`;
      meta.textContent = `${status} · ${item.moveCount ?? item.moves?.length ?? 0} 手 · ${item.mode === 'ai' ? DIFFICULTY[item.difficulty] || '标准' : '双人'}\n${formatDate(item.updatedAt || item.createdAt)}`;
      info.append(title, meta);
      const actions = document.createElement('div'); actions.className = 'history-actions';
      if (item.status === 'active') {
        const resume = document.createElement('button'); resume.textContent = '继续'; resume.disabled = busy;
        resume.addEventListener('click', () => loadGame(item.id, false)); actions.append(resume);
      }
      const review = document.createElement('button'); review.textContent = '复盘'; review.disabled = busy;
      review.addEventListener('click', () => loadGame(item.id, true)); actions.append(review);
      row.append(info, actions); $('#history-list').append(row);
    });
  } catch (error) {
    $('#history-list').replaceChildren();
    const failure = document.createElement('p'); failure.className = 'empty-history'; failure.textContent = messageOf(error); $('#history-list').append(failure);
    const retry = document.createElement('button'); retry.className = 'button button-quiet'; retry.textContent = '重新读取'; retry.addEventListener('click', openHistory); $('#history-list').append(retry);
  }
}
async function loadGame(id, review) {
  if (busy) return;
  $('#history-dialog').close();
  await runAction('正在载入棋谱', async () => {
    const result = await api(`/api/games/${encodeURIComponent(id)}`);
    replayAt = review ? result.game.moves.length : null;
    acceptGame(result.game);
    $('#agent-trace').hidden = true;
    if (!review) await maybeAgent();
    announce(review ? '棋谱已载入，可逐手复盘。' : '已恢复对局。');
  });
}
$('#nav-history').addEventListener('click', openHistory);
$('#open-history').addEventListener('click', openHistory);
$('#nav-play').addEventListener('click', () => {
  if (replayAt !== null) exitReplay();
  $('#board').focus();
});
function setReplay(number) {
  if (busy || !game) return;
  replayAt = Math.max(0, Math.min(game.moves.length, number));
  analysis = null; hintVisible = false; $('#agent-trace').hidden = true;
  render();
  announce(`复盘第 ${replayAt} 手。`);
}
$('#replay-slider').addEventListener('input', event => setReplay(Number(event.target.value)));
$('#replay-first').addEventListener('click', () => setReplay(0));
$('#replay-prev').addEventListener('click', () => setReplay(replayAt - 1));
$('#replay-next').addEventListener('click', () => setReplay(replayAt + 1));
$('#replay-last').addEventListener('click', () => setReplay(game.moves.length));
async function exitReplay() {
  if (busy) return;
  replayAt = null; analysis = null; hintVisible = false;
  render();
  await runAction('正在恢复对局', maybeAgent);
}
$('#exit-replay').addEventListener('click', exitReplay);

async function initialize() {
  render();
  setBusy(true, '正在连接对局服务');
  try {
    const config = await api('/api/config');
    serverAI = config.ai || serverAI;
    const existingId = loadPreference('gomoku.currentGame');
    let result;
    if (existingId) {
      try { result = await api(`/api/games/${encodeURIComponent(existingId)}`); } catch (error) {
        // A missing old id can occur after a deployment changes database; other errors must stay visible.
        if (!/404|不存在|not found/i.test(error.message)) throw error;
        savePreference('gomoku.currentGame', null);
      }
    }
    if (!result) result = await api('/api/games', {mode:'ai',difficulty:'standard',humanColor:1});
    acceptGame(result.game, result.analysis);
    await maybeAgent();
  } catch (error) {
    toast(messageOf(error));
    $('#connection-label').textContent = '服务连接失败';
    $('#insight-title').textContent = '暂时无法连接对局服务。';
    $('#insight-text').textContent = '请确认后端正在运行，稍后刷新页面。也可以点击「开启新对局」重试。';
  } finally {
    setBusy(false);
    if (!game) {
      $('#connection-label').textContent = '服务连接失败';
      $('#insight-title').textContent = '暂时无法连接对局服务。';
      $('#insight-text').textContent = '请确认后端正在运行，稍后刷新页面。也可以点击「开启新对局」重试。';
    }
  }
}
initialize();
