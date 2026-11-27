import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, extname } from 'node:path';
import { openStore } from './lib/db.js';
import { SIZE, boardFromMoves, getWinner, isDraw, analyzePosition, analyzeMove } from './lib/engine.js';
import { runAgent } from './lib/ai.js';
import pkg from './package.json' with { type: 'json' };

const root = fileURLToPath(new URL('.',import.meta.url));
const cookieName = 'yijing_session';
const error = (status,code,message) => Object.assign(new Error(message),{status,code});
const headers = {
  'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};

export function createApp({ dataDir = process.env.DATA_DIR || join(root,'data') } = {}) {
  const store = openStore(resolve(dataDir));
  const busy = new Set(); const limits = new Map();
  const server = createServer(async (req,res) => {
    Object.entries(headers).forEach(([k,v])=>res.setHeader(k,v));
    const send = (status,body) => { if (res.destroyed) return; res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(body)); };
    let owner;
    try {
      const url = new URL(req.url,'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET','HEAD'].includes(req.method)) throw error(405,'METHOD_NOT_ALLOWED','请求方法不支持。');
        const paths = { '/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js','/favicon.svg':'favicon.svg','/winter.css':'winter.css','/scene.js':'scene.js','/assets/winter-plum.png':'assets/winter-plum.png' };
        const filename = paths[url.pathname];
        if (!filename) throw error(404,'NOT_FOUND','页面不存在。');
        let data;try {data=await readFile(join(root,'public',filename));} catch {throw error(404,'NOT_FOUND','文件不存在。');}
        const type = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'}[extname(filename)];
        res.writeHead(200,{'Content-Type':type,'Cache-Control':filename.endsWith('.html')?'no-cache':'public, max-age=300'});
        res.end(req.method==='HEAD'?undefined:data);return;
      }
      if (req.method==='GET' && url.pathname==='/api/health') {send(200,{status:'ok',storage:'sqlite',version:pkg.version});return;}
      if (!['GET','POST'].includes(req.method)) throw error(405,'METHOD_NOT_ALLOWED','请求方法不支持。');
      // Browsers may only change games from this application's own origin.
      if (req.headers['sec-fetch-site']==='cross-site') throw error(403,'ORIGIN_DENIED','请从本站访问对局。');
      if (req.method==='POST' && req.headers.origin) {
        let origin;try {origin=new URL(req.headers.origin);}catch {throw error(403,'ORIGIN_DENIED','请求来源无效。');}
        if (!['http:','https:'].includes(origin.protocol)||origin.host!==req.headers.host) throw error(403,'ORIGIN_DENIED','请求来源无效。');
      }
      const cookie = (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
      const token = /^[a-f0-9]{64}$/.test(cookie||'') ? cookie : randomBytes(32).toString('hex');
      if (token!==cookie) res.setHeader('Set-Cookie',`${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${req.socket.encrypted||req.headers['x-forwarded-proto']==='https'?'; Secure':''}`);
      owner = createHash('sha256').update(token).digest('hex');
      const now = Date.now();
      // A reverse proxy may put every visitor on the same socket address.
      // Use the isolated browser session so one visitor cannot exhaust others' quota.
      const rateKey = owner;
      let limit = limits.get(rateKey); if (!limit || now-limit.start>60000) {limit={start:now,count:0};limits.set(rateKey,limit);}
      if (++limit.count>240) {res.setHeader('Retry-After','60');throw error(429,'RATE_LIMIT','请求过于频繁，请稍后重试。');}
      if(limits.size>2000) for(const [key,val]of limits)if(now-val.start>60000)limits.delete(key);
      if(req.method==='GET'&&url.pathname==='/api/config') {send(200,{size:SIZE,rules:'freestyle',ai:{configured:process.env.ALLOW_SHARED_AI==='true'&&!!process.env.AI_API_KEY,model:process.env.AI_MODEL||'gpt-4o-mini'}});return;}
      if(req.method==='GET'&&url.pathname==='/api/games') {send(200,{games:store.list(owner)});return;}
      let body = {};
      if (req.method==='POST') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')) throw error(415,'JSON_REQUIRED','请使用 JSON 请求。');
        let size=0;const chunks=[];
        for await (const chunk of req) {size+=chunk.length;if(size>16384)throw error(413,'BODY_TOO_LARGE','请求内容过大。');chunks.push(chunk);}
        try {body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch {throw error(400,'INVALID_JSON','JSON 格式不正确。');}
        if (!body||typeof body!=='object'||Array.isArray(body)) throw error(400,'INVALID_BODY','请求内容无效。');
      }
      if(req.method==='POST'&&url.pathname==='/api/games') {
        const {mode='ai',difficulty='standard',humanColor=1}=body;
        if (!['ai','local'].includes(mode)||!['easy','standard','hard'].includes(difficulty)||![1,2].includes(humanColor)) throw error(400,'INVALID_OPTIONS','对局设置无效。');
        send(201,{game:store.create(owner,{mode,difficulty,humanColor})});return;
      }
      const match = /^\/api\/games\/([a-f0-9-]{36})(?:\/(moves|agent|undo|hint|analyze|export))?$/.exec(url.pathname);
      if(!match) throw error(404,'NOT_FOUND','接口不存在。');
      const [,id,action]=match;
      const game=store.get(owner,id);if(!game)throw error(404,'GAME_NOT_FOUND','对局不存在或不属于当前浏览器。');
      if(req.method==='GET'&&!action){send(200,{game});return;}
      if(req.method==='GET'&&action==='export') {
        const format=url.searchParams.get('format')||'json';
        if(!['json','sgf'].includes(format))throw error(400,'INVALID_FORMAT','支持 JSON 或 SGF 格式。');
        const content=format==='json'?JSON.stringify({format:'yijing-gomoku',version:1,rules:'freestyle',size:SIZE,...game},null,2):toSGF(game);
        res.writeHead(200,{'Content-Type':format==='json'?'application/json; charset=utf-8':'application/x-go-sgf; charset=utf-8','Content-Disposition':`attachment; filename="yijing-${id}.${format}"`,'Cache-Control':'no-store'});res.end(content);return;
      }
      if(req.method!=='POST') throw error(405,'METHOD_NOT_ALLOWED','请求方法不支持。');
      if(!action||action==='export')throw error(405,'METHOD_NOT_ALLOWED','请求方法不支持。');
      const lockKey=`${owner}:${id}`;
      if (busy.has(lockKey)) throw error(409,'GAME_BUSY','AI 正在思考，请等待当前操作完成。');
      busy.add(lockKey);
      try {
        if(action==='moves') {
          const {x,y}=body;
          if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||x>=SIZE||y<0||y>=SIZE)throw error(400,'INVALID_COORDINATE','落子坐标必须在棋盘范围内。');
          if(game.status!=='active')throw error(409,'GAME_FINISHED','对局已经结束。');
          if(game.mode==='ai'&&game.currentPlayer!==game.humanColor)throw error(409,'AGENT_TURN','当前轮到 AI。');
          if(game.board[y][x]!==0)throw error(409,'CELL_OCCUPIED','此处已有棋子。');
          const move={x,y,player:game.currentPlayer};
          const next=store.append(owner,id,game.revision,move,analyzeMove(game.board,move));
          send(200,{game:next,analysis:analyzePosition(next.board,next.currentPlayer)});return;
        }
        if(action==='undo'){send(200,{game:store.undo(owner,id)});return;}
        if(action==='agent') {
          if(game.status!=='active')throw error(409,'GAME_FINISHED','对局已经结束。');
          if(game.mode!=='ai'||game.currentPlayer===game.humanColor)throw error(409,'HUMAN_TURN','当前不需要 AI 落子。');
          const result=await runAgent({board:game.board,player:game.currentPlayer,purpose:'move',ai:body.ai,difficulty:game.difficulty,history:game.moves,analysis:analyzePosition(game.board,game.currentPlayer)});
          const move={...result.move,player:game.currentPlayer};
          if(!Number.isInteger(move.x)||!Number.isInteger(move.y)||game.board[move.y]?.[move.x]!==0)throw error(502,'INVALID_AGENT_MOVE','AI 未生成合法落子，请重试。');
          const feedback={...analyzeMove(game.board,move),...(result.analysis?.coach?{agentCoach:result.analysis.coach}:{})};
          const next=store.append(owner,id,game.revision,move,feedback);
          send(200,{game:next,agent:result.agent,analysis:{...analyzePosition(next.board,next.currentPlayer),...(result.analysis?.coach?{coach:result.analysis.coach}:{})}});return;
        }
        if(action==='hint'||action==='analyze') {
          if(body.moveNumber!==undefined&&(!Number.isInteger(body.moveNumber)||body.moveNumber<0||body.moveNumber>game.moves.length))throw error(400,'INVALID_MOVE_NUMBER','复盘步数不正确。');
          const moves=game.moves.slice(0,body.moveNumber??game.moves.length);
          const board=boardFromMoves(moves);const player=moves.length%2?2:1;
          const analysis=analyzePosition(board,player);
          const result=await runAgent({board,player,purpose:action,ai:body.ai,difficulty:game.difficulty,history:moves,analysis});
          result.analysis.stats={excellent:0,good:0,inaccuracy:0,mistake:0};
          for(const move of moves)if(move.quality in result.analysis.stats)result.analysis.stats[move.quality]++;
          send(200,result);return;
        }
      } finally {busy.delete(lockKey);}
    } catch(e) {
      // Provider errors and request bodies may contain secrets; only expose fixed messages.
      if(!e.status) console.error('Request failed:',e.code||e.name||'Error');
      send(e.status||500,{error:{code:e.code||'INTERNAL_ERROR',message:e.status?e.message:'服务暂时不可用，请稍后重试。'}});
    }
  });
  server.requestTimeout=20000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  server.on('close',()=>store.close());
  return server;
}

export function toSGF(game) {
  const esc=text=>String(text).replace(/\\/g,'\\\\').replace(/\]/g,'\\]');
  const result=game.winner?`${game.winner===1?'B':'W'}+`:game.status==='draw'?'0':'?';
  return `(;GM[4]FF[4]CA[UTF-8]AP[Yijing:${pkg.version}]SZ[15]RU[Freestyle]GN[${esc(game.title)}]DT[${game.createdAt.slice(0,10)}]RE[${result}]PB[${game.mode==='ai'&&game.humanColor===2?'Yijing AI':'Black'}]PW[${game.mode==='ai'&&game.humanColor===1?'Yijing AI':'White'}]${game.moves.map(m=>`;${m.player===1?'B':'W'}[${String.fromCharCode(97+m.x)}${String.fromCharCode(97+m.y)}]C[${esc(m.explanation||'')}]`).join('')})\n`;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const app=createApp();const port=Number(process.env.PORT)||3000;const host=process.env.HOST||'0.0.0.0';
  app.listen(port,host,()=>console.log(`弈境已启动：http://${host==='0.0.0.0'?'localhost':host}:${port}`));
  for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>{app.close();setTimeout(()=>process.exit(0),15000).unref();});
}
