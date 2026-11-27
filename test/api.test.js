import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(),'yijing-api-'));
  let server;
  const start = async () => {server=createApp({dataDir});server.listen(0,'127.0.0.1');await once(server,'listening');};
  await start();
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dataDir,{recursive:true,force:true});});
  const client = () => {
    let cookie='';
    return async(path,body,options={})=>{
      const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body===undefined?'GET':'POST',...options,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{}),...options.headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
      cookie=response.headers.get('set-cookie')?.split(';')[0]||cookie;
      const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
      return {status:response.status,data,headers:response.headers};
    };
  };
  return {client,restart:async()=>{await new Promise(resolve=>server.close(resolve));await start();}};
}

test('SQLite persists games and move feedback through a server restart',async t=>{
  const {client,restart}=await setup(t);const api=client();
  const created=await api('/api/games',{mode:'local'});
  assert.equal(created.status,201);const id=created.data.game.id;
  assert.match(created.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  const moved=await api(`/api/games/${id}/moves`,{x:7,y:7});
  assert.equal(moved.status,200);assert.equal(moved.data.game.board[7][7],1);
  assert.ok(moved.data.game.moves[0].explanation);
  await restart();const read=await api(`/api/games/${id}`);
  assert.equal(read.data.game.moves.length,1);assert.equal(read.data.game.currentPlayer,2);
  const list=await api('/api/games');assert.equal(list.data.games[0].moveCount,1);
});

test('each browser can only access its own games, including exports',async t=>{
  const {client}=await setup(t);const a=client(),b=client();
  const {data:{game}}=await a('/api/games',{});
  assert.equal((await b('/api/games')).data.games.length,0);
  for(const suffix of ['', '/export?format=json'])assert.equal((await b(`/api/games/${game.id}${suffix}`)).status,404);
  assert.equal((await b(`/api/games/${game.id}/moves`,{x:1,y:1})).status,404);
});

test('validates coordinates, occupancy, JSON and same-origin requests',async t=>{
  const {client}=await setup(t);const api=client();const {data:{game}}=await api('/api/games',{mode:'local'});
  for(const position of [{x:-1,y:0},{x:15,y:0},{x:1.5,y:2},{x:'1',y:1}])assert.equal((await api(`/api/games/${game.id}/moves`,position)).status,400);
  assert.equal((await api(`/api/games/${game.id}/moves`,{x:0,y:0})).status,200);
  assert.equal((await api(`/api/games/${game.id}/moves`,{x:0,y:0})).status,409);
  assert.equal((await api('/api/games',{}, {headers:{Origin:'https://other.example'}})).status,403);
  assert.equal((await api('/api/games',{}, {headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await api('/api/games',{}, {headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await api('/api/games',{mode:'online'})).status,400);
  assert.equal((await api('/api/games',{humanColor:'black'})).status,400);
});

test('a completed five-in-a-row cannot accept extra moves and can be undone',async t=>{
  const {client}=await setup(t);const api=client();const {data:{game}}=await api('/api/games',{mode:'local'});
  let last;
  for(const [x,y]of [[0,0],[0,2],[1,0],[1,2],[2,0],[2,2],[3,0],[3,2],[4,0]]){
    last=await api(`/api/games/${game.id}/moves`,{x,y});assert.equal(last.status,200);
  }
  assert.equal(last.data.game.status,'won');assert.equal(last.data.game.winner,1);
  assert.equal((await api(`/api/games/${game.id}/moves`,{x:9,y:9})).status,409);
  const undo=await api(`/api/games/${game.id}/undo`,{});
  assert.equal(undo.data.game.status,'active');assert.equal(undo.data.game.winner,null);assert.equal(undo.data.game.moves.length,8);
});

test('AI acts only on its turn and undo removes the human move with its reply',async t=>{
  const {client}=await setup(t);const api=client();const {data:{game}}=await api('/api/games',{mode:'ai',humanColor:1});
  assert.equal((await api(`/api/games/${game.id}/agent`,{})).status,409);
  await api(`/api/games/${game.id}/moves`,{x:7,y:7});
  assert.equal((await api(`/api/games/${game.id}/moves`,{x:8,y:7})).status,409);
  const next=await api(`/api/games/${game.id}/agent`,{ai:{disabled:true}});
  assert.equal(next.status,200);assert.equal(next.data.game.moves.length,2);assert.equal(next.data.agent.source,'local');
  assert.ok(next.data.analysis.summary);assert.ok(next.data.agent.steps.length);
  const undo=await api(`/api/games/${game.id}/undo`,{});assert.equal(undo.data.game.moves.length,0);
});

test('human can choose white and the agent opens as black',async t=>{
  const {client}=await setup(t);const api=client();const {data:{game}}=await api('/api/games',{mode:'ai',humanColor:2});
  const next=await api(`/api/games/${game.id}/agent`,{ai:{disabled:true}});
  assert.equal(next.status,200);assert.equal(next.data.game.moves[0].player,1);assert.equal(next.data.game.currentPlayer,2);
  await api(`/api/games/${game.id}/moves`,{x:8,y:8});
  await api(`/api/games/${game.id}/agent`,{ai:{disabled:true}});
  const undo=await api(`/api/games/${game.id}/undo`,{});
  assert.equal(undo.data.game.moves.length,1);assert.equal(undo.data.game.currentPlayer,2);
});

test('hint and historical analysis are read-only and export preserves all positions',async t=>{
  const {client}=await setup(t);const api=client();const {data:{game}}=await api('/api/games',{mode:'local'});
  await api(`/api/games/${game.id}/moves`,{x:0,y:0});await api(`/api/games/${game.id}/moves`,{x:14,y:14});
  const hint=await api(`/api/games/${game.id}/hint`,{ai:{disabled:true}});
  assert.equal(hint.status,200);assert.ok(hint.data.analysis.recommendation);
  const analyzed=await api(`/api/games/${game.id}/analyze`,{moveNumber:1,ai:{disabled:true}});
  assert.equal(analyzed.status,200);assert.ok(analyzed.data.analysis.stats);
  assert.equal((await api(`/api/games/${game.id}/analyze`,{moveNumber:3})).status,400);
  const json=await api(`/api/games/${game.id}/export?format=json`);
  assert.equal(json.data.moves.length,2);assert.equal(json.data.size,15);assert.equal(json.data.rules,'freestyle');
  assert.match(json.headers.get('content-disposition'),/attachment/);
  const sgf=await api(`/api/games/${game.id}/export?format=sgf`);
  assert.match(sgf.data,/GM\[4\]/);assert.match(sgf.data,/;B\[aa\]/);assert.match(sgf.data,/;W\[oo\]/);
  assert.equal((await api(`/api/games/${game.id}`)).data.game.moves.length,2);
});

test('health and static assets are served with security headers; traversal is rejected',async t=>{
  const {client}=await setup(t);const api=client();
  const health=await api('/api/health');assert.equal(health.data.storage,'sqlite');
  const index=await api('/');assert.equal(index.status,200);assert.match(index.data,/<html/);
  assert.match(index.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await api('/.env')).status,404);assert.equal((await api('/data/gomoku.sqlite')).status,404);
});
