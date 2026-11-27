import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAPI } from '../browser/api.js';
import { createBrowserStore, createMemoryStore } from '../browser/store.js';
import { chooseMove, analyzePosition } from '../lib/engine.js';

const localAgent = async ({board,player,difficulty,analysis}) => {
  const move=chooseMove(board,player,{difficulty});
  return {move,analysis:{...(analysis||analyzePosition(board,player)),recommendation:move},agent:{source:'local',fallback:false,message:'本地分析完成。',steps:[{tool:'inspect_board',summary:'已检查棋盘。'}]}};
};
const runtime = store => createBrowserAPI({store:store||createMemoryStore(),runAgent:localAgent,locks:null});

test('browser runtime resumes stored games across API instances and does not leak mutable snapshots',async()=>{
  const store=createMemoryStore(),first=runtime(store);
  const {game}=await first.request('/api/games',{mode:'local'});
  const moved=await first.request(`/api/games/${game.id}/moves`,{x:7,y:7});
  moved.game.board[7][7]=2;moved.game.moves.length=0;
  const second=runtime(store);
  const restored=await second.request(`/api/games/${game.id}`);
  assert.equal(restored.game.board[7][7],1);assert.equal(restored.game.moves.length,1);
  assert.equal(restored.game.currentPlayer,2);assert.ok(restored.game.moves[0].explanation);
  const history=await second.request('/api/games');
  assert.equal(history.games.length,1);assert.equal(history.games[0].moveCount,1);
});

test('missing browser storage is explicitly reported as temporary memory',async()=>{
  const store=await createBrowserStore({indexedDB:null});
  const config=await runtime(store).request('/api/config');
  assert.equal(config.runtime,'browser');assert.equal(config.storage,'memory');assert.equal(config.storagePersistent,false);
  const failed=await createBrowserStore({indexedDB:{open(){throw new Error('Private browser policy');}}});
  assert.equal(failed.storagePersistent,false);
});

test('browser game validates options, coordinates, occupancy, turns and finished states',async()=>{
  const api=runtime();
  await assert.rejects(api.request('/api/games',{mode:'network'}),{code:'INVALID_OPTIONS'});
  await assert.rejects(api.request('/api/games',{humanColor:'1'}),{code:'INVALID_OPTIONS'});
  const {game}=await api.request('/api/games',{mode:'local'});
  for(const move of [{x:-1,y:0},{x:15,y:0},{x:1.5,y:0},{x:'1',y:0}])await assert.rejects(api.request(`/api/games/${game.id}/moves`,move),{code:'INVALID_COORDINATE'});
  for(const [x,y]of [[0,0],[0,2],[1,0],[1,2],[2,0],[2,2],[3,0],[3,2],[4,0]])await api.request(`/api/games/${game.id}/moves`,{x,y});
  const won=(await api.request(`/api/games/${game.id}`)).game;
  assert.equal(won.status,'won');assert.equal(won.winner,1);
  await assert.rejects(api.request(`/api/games/${game.id}/moves`,{x:8,y:8}),{code:'GAME_FINISHED'});
  const undone=await api.request(`/api/games/${game.id}/undo`,{});
  assert.equal(undone.game.status,'active');assert.equal(undone.game.moves.length,8);
  await assert.rejects(api.request(`/api/games/${game.id}/moves`,{x:0,y:0}),{code:'CELL_OCCUPIED'});
});

test('browser AI preserves human moves before replies, follows color, and undoes a complete pair',async()=>{
  const api=runtime();
  const {game}=await api.request('/api/games',{mode:'ai',humanColor:2,difficulty:'hard'});
  await assert.rejects(api.request(`/api/games/${game.id}/moves`,{x:7,y:7}),{code:'AGENT_TURN'});
  const opened=await api.request(`/api/games/${game.id}/agent`,{ai:{disabled:true}});
  assert.equal(opened.game.moves[0].player,1);assert.equal(opened.game.currentPlayer,2);
  await assert.rejects(api.request(`/api/games/${game.id}/agent`,{}),{code:'HUMAN_TURN'});
  await api.request(`/api/games/${game.id}/moves`,{x:8,y:8});
  assert.equal((await api.request(`/api/games/${game.id}`)).game.moves.length,2);
  await api.request(`/api/games/${game.id}/agent`,{});
  const undo=await api.request(`/api/games/${game.id}/undo`,{});
  assert.equal(undo.game.moves.length,1);assert.equal(undo.game.currentPlayer,2);
});

test('historical browser analysis is read-only and both export formats retain positions',async()=>{
  const api=runtime();const {game}=await api.request('/api/games',{mode:'local'});
  await api.request(`/api/games/${game.id}/moves`,{x:0,y:0});await api.request(`/api/games/${game.id}/moves`,{x:14,y:14});
  const before=(await api.request(`/api/games/${game.id}`)).game;
  const hint=await api.request(`/api/games/${game.id}/hint`,{});
  assert.ok(hint.analysis.recommendation);
  const analysis=await api.request(`/api/games/${game.id}/analyze`,{moveNumber:1});
  assert.equal(Object.values(analysis.analysis.stats).reduce((a,b)=>a+b,0),1);
  await assert.rejects(api.request(`/api/games/${game.id}/analyze`,{moveNumber:3}),{code:'INVALID_MOVE_NUMBER'});
  assert.deepEqual((await api.request(`/api/games/${game.id}`)).game,before);
  const json=await api.exportGame(game.id,'json');const content=JSON.parse(json.content);
  assert.equal(content.moves.length,2);assert.equal(content.size,15);assert.match(json.filename,/\.json$/);
  const sgf=await api.exportGame(game.id,'sgf');
  assert.match(sgf.content,/GM\[4\]/);assert.match(sgf.content,/;B\[aa\]/);assert.match(sgf.content,/;W\[oo\]/);
  await assert.rejects(api.exportGame(game.id,'txt'),{code:'INVALID_FORMAT'});
});

test('storage revision checks reject stale writes and failed saves never accept an unsaved move',async()=>{
  const store=createMemoryStore(),api=runtime(store);const {game}=await api.request('/api/games',{mode:'local'});
  await api.request(`/api/games/${game.id}/moves`,{x:7,y:7});
  await assert.rejects(store.replace(game.id,game.revision,game),{code:'STALE_GAME'});
  const faultyStore={...store,async replace(){throw Object.assign(new Error('Storage quota reached'),{code:'STORAGE_WRITE_FAILED'});}};
  await assert.rejects(runtime(faultyStore).request(`/api/games/${game.id}/moves`,{x:8,y:8}),{code:'STORAGE_WRITE_FAILED'});
  assert.equal((await api.request(`/api/games/${game.id}`)).game.moves.length,1);
});

test('browser exports and stored feedback never contain request credentials, including an echoed coach',async()=>{
  const store=createMemoryStore();
  const api=createBrowserAPI({store,locks:null,runAgent:async input=>{
    const result=await localAgent(input);result.analysis.coach=`说明 ${input.ai.apiKey} 已隐藏`;
    return result;
  }});
  const {game}=await api.request('/api/games',{mode:'ai'});
  await api.request(`/api/games/${game.id}/moves`,{x:7,y:7});
  const next=await api.request(`/api/games/${game.id}/agent`,{ai:{apiKey:'browser-credential-test',baseUrl:'https://provider.example/v1',model:'test'}});
  assert.equal(next.analysis.coach.includes('browser-credential-test'),false);
  assert.equal(JSON.stringify(await store.list()).includes('browser-credential-test'),false);
  assert.equal((await api.exportGame(game.id,'json')).content.includes('browser-credential-test'),false);
  assert.equal(JSON.stringify(await store.list()).includes('provider.example'),false);
});

test('invalid browser Agent moves leave persisted human turn intact for retry',async()=>{
  const store=createMemoryStore(),api=createBrowserAPI({store,locks:null,runAgent:async()=>({move:{x:7,y:7},analysis:{},agent:{}})});
  const {game}=await api.request('/api/games',{mode:'ai'});
  await api.request(`/api/games/${game.id}/moves`,{x:7,y:7});
  await assert.rejects(api.request(`/api/games/${game.id}/agent`,{}),{code:'INVALID_AGENT_MOVE'});
  assert.equal((await api.request(`/api/games/${game.id}`)).game.moves.length,1);
  const retry=await runtime(store).request(`/api/games/${game.id}/agent`,{});
  assert.equal(retry.game.moves.length,2);
});
