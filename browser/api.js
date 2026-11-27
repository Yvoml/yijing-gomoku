import { SIZE, createBoard, boardFromMoves, getWinner, isDraw, analyzePosition, analyzeMove } from '../lib/engine.js';
import { createBrowserStore } from './store.js';

const error = (code,message) => Object.assign(new Error(message),{code});
const clone = value => structuredClone(value);
const isCoordinate = value => Number.isInteger(value) && value >= 0 && value < SIZE;
const lockBusy = new Set();

/** The same UI contracts as the HTTP service, using only this browser's data. */
export function createBrowserAPI({ store: suppliedStore, runAgent: agentOverride, version = '0.5.0', locks = globalThis.navigator?.locks } = {}) {
  const ready = suppliedStore ? Promise.resolve(suppliedStore) : createBrowserStore();
  const runAgent = agentOverride || (async input => (await import('./ai.js')).runBrowserAgent(input));
  const get = async id => {
    const game = await (await ready).get(id);
    if(!game) throw error('GAME_NOT_FOUND','对局不存在，请从历史棋谱重新选择。');
    return game;
  };
  async function withLock(id, action) {
    if(lockBusy.has(id))throw error('GAME_BUSY','当前对局正在处理，请等待操作完成。');
    lockBusy.add(id);
    try {
      return locks?.request ? await locks.request(`yijing-gomoku:${id}`,action) : await action();
    } finally {lockBusy.delete(id);}
  }
  function redact(value,ai) {
    const key=typeof ai?.apiKey==='string'?ai.apiKey.trim():'';
    return typeof value==='string' && key ? value.split(key).join('[已隐藏密钥]') : value;
  }
  async function append(game,move,feedback) {
    if(!isCoordinate(move.x)||!isCoordinate(move.y)||game.board[move.y][move.x]!==0||move.player!==game.currentPlayer||game.status!=='active')throw error('ILLEGAL_MOVE','当前落子不合法，请刷新棋盘后重试。');
    const next=clone(game),now=new Date().toISOString();
    next.moves.push({...feedback,x:move.x,y:move.y,player:move.player,number:next.moves.length+1,createdAt:now});
    next.board[move.y][move.x]=move.player;
    next.winner=getWinner(next.board,move.x,move.y)||null;
    next.status=next.winner?'won':isDraw(next.board)?'draw':'active';
    next.currentPlayer=3-move.player;next.updatedAt=now;next.revision++;
    return await (await ready).replace(game.id,game.revision,next);
  }
  const position = game => analyzePosition(game.board,game.currentPlayer);
  async function request(path,body) {
    const url=new URL(path,'https://yijing.invalid');
    if(url.pathname==='/api/config'&&body===undefined){
      const store=await ready;
      return {runtime:'browser',storage:store.storage,storagePersistent:store.storagePersistent,size:SIZE,rules:'freestyle',ai:{configured:false,model:''}};
    }
    if(body!==undefined&&(!body||typeof body!=='object'||Array.isArray(body)))throw error('INVALID_BODY','请求内容无效。');
    if(url.pathname==='/api/games') {
      const store=await ready;
      if(body===undefined){
        return {games:(await store.list()).map(game=>({id:game.id,title:game.title,mode:game.mode,difficulty:game.difficulty,humanColor:game.humanColor,status:game.status,winner:game.winner,moveCount:game.moves.length,createdAt:game.createdAt,updatedAt:game.updatedAt}))};
      }
      const {mode='ai',difficulty='standard',humanColor=1}=body;
      if(!['ai','local'].includes(mode)||!['easy','standard','hard'].includes(difficulty)||![1,2].includes(humanColor))throw error('INVALID_OPTIONS','对局设置无效。');
      const now=new Date().toISOString();
      const title=`${mode==='ai'?'人机对弈':'双人对弈'} · ${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())}`;
      const game={id:crypto.randomUUID(),title,mode,difficulty,humanColor,status:'active',winner:null,revision:0,createdAt:now,updatedAt:now,moves:[],board:createBoard(),currentPlayer:1};
      return {game:await store.create(game)};
    }
    const match=/^\/api\/games\/([a-f0-9-]{36})(?:\/(moves|agent|undo|hint|analyze))?$/.exec(url.pathname);
    if(!match)throw error('NOT_FOUND','接口不存在。');
    const [,id,action]=match;
    if(!action&&body===undefined)return {game:await get(id)};
    if(!action||body===undefined)throw error('METHOD_NOT_ALLOWED','请求方法不支持。');
    return await withLock(id,async()=>{
      const game=await get(id);
      if(action==='moves'){
        const {x,y}=body;
        if(!isCoordinate(x)||!isCoordinate(y))throw error('INVALID_COORDINATE','落子坐标必须在棋盘范围内。');
        if(game.status!=='active')throw error('GAME_FINISHED','对局已经结束。');
        if(game.mode==='ai'&&game.currentPlayer!==game.humanColor)throw error('AGENT_TURN','当前轮到 AI。');
        if(game.board[y][x])throw error('CELL_OCCUPIED','此处已有棋子。');
        const move={x,y,player:game.currentPlayer};
        const next=await append(game,move,analyzeMove(game.board,move));
        return {game:next,analysis:position(next)};
      }
      if(action==='undo'){
        if(!game.moves.length)return {game};
        const next=clone(game);
        const humanIndex=game.moves.findLastIndex(move=>move.player===game.humanColor);
        const keep=game.mode==='ai'?Math.max(0,humanIndex):game.moves.length-1;
        next.moves=next.moves.slice(0,keep);next.board=boardFromMoves(next.moves);
        next.currentPlayer=next.moves.length%2?2:1;next.status='active';next.winner=null;
        next.updatedAt=new Date().toISOString();next.revision++;
        return {game:await (await ready).replace(id,game.revision,next)};
      }
      if(action==='agent'){
        if(game.status!=='active')throw error('GAME_FINISHED','对局已经结束。');
        if(game.mode!=='ai'||game.currentPlayer===game.humanColor)throw error('HUMAN_TURN','当前不需要 AI 落子。');
        const result=await runAgent({board:clone(game.board),player:game.currentPlayer,purpose:'move',ai:body.ai,difficulty:game.difficulty,history:clone(game.moves),analysis:position(game)});
        const move={...result.move,player:game.currentPlayer};
        if(!isCoordinate(move.x)||!isCoordinate(move.y)||game.board[move.y][move.x])throw error('INVALID_AGENT_MOVE','AI 未生成合法落子，请重试。');
        const coach=redact(result.analysis?.coach,body.ai);
        const feedback={...analyzeMove(game.board,move),...(coach?{agentCoach:coach}:{})};
        const next=await append(game,move,feedback);
        return {game:next,agent:result.agent,analysis:{...position(next),...(coach?{coach}:{})}};
      }
      if(action==='hint'||action==='analyze'){
        if(body.moveNumber!==undefined&&(!Number.isInteger(body.moveNumber)||body.moveNumber<0||body.moveNumber>game.moves.length))throw error('INVALID_MOVE_NUMBER','复盘步数不正确。');
        const moves=game.moves.slice(0,body.moveNumber??game.moves.length);
        const board=boardFromMoves(moves),player=moves.length%2?2:1;
        const result=await runAgent({board,player,purpose:action,ai:body.ai,difficulty:game.difficulty,history:clone(moves),analysis:analyzePosition(board,player)});
        const stats={excellent:0,good:0,inaccuracy:0,mistake:0};
        for(const move of moves)if(move.quality in stats)stats[move.quality]++;
        return {...result,analysis:{...result.analysis,...(result.analysis?.coach?{coach:redact(result.analysis.coach,body.ai)}:{}),stats}};
      }
      throw error('NOT_FOUND','接口不存在。');
    });
  }
  async function exportGame(id,format='json') {
    if(!['json','sgf'].includes(format))throw error('INVALID_FORMAT','支持 JSON 或 SGF 格式。');
    const game=await get(id);
    const contentType=format==='json'?'application/json; charset=utf-8':'application/x-go-sgf; charset=utf-8';
    let content;
    if(format==='json')content=JSON.stringify({format:'yijing-gomoku',version:1,rules:'freestyle',size:SIZE,...game},null,2);
    else {
      const esc=text=>String(text).replace(/\\/g,'\\\\').replace(/\]/g,'\\]');
      const result=game.winner?`${game.winner===1?'B':'W'}+`:game.status==='draw'?'0':'?';
      content=`(;GM[4]FF[4]CA[UTF-8]AP[Yijing:${version}]SZ[15]RU[Freestyle]GN[${esc(game.title)}]DT[${game.createdAt.slice(0,10)}]RE[${result}]PB[${game.mode==='ai'&&game.humanColor===2?'Yijing AI':'Black'}]PW[${game.mode==='ai'&&game.humanColor===1?'Yijing AI':'White'}]${game.moves.map(move=>`;${move.player===1?'B':'W'}[${String.fromCharCode(97+move.x)}${String.fromCharCode(97+move.y)}]C[${esc(move.explanation||'')}]`).join('')})\n`;
    }
    return {content,contentType,filename:`yijing-${id}.${format}`};
  }
  return {request,exportGame,async config(){return await request('/api/config');},async close(){(await ready).close();}};
}
