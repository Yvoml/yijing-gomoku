const clone = value => value == null ? value : structuredClone(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const missing = () => fail('GAME_NOT_FOUND', '对局不存在，请从历史棋谱重新选择。');
const stale = () => fail('STALE_GAME', '对局已在另一个页面改变，请刷新后继续。');
const full = () => fail('GAME_LIMIT', '当前浏览器已保存 500 局，请先导出需要保留的棋谱。');

/** Explicit temporary storage for browsers which disable IndexedDB. */
export function createMemoryStore() {
  const games = new Map();
  return {
    storage: 'memory', storagePersistent: false,
    async get(id) { return clone(games.get(id) || null); },
    async list() { return [...games.values()].map(clone).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); },
    async create(game) {
      if (games.size >= 500) throw full();
      if (games.has(game.id)) throw stale();
      games.set(game.id, clone(game)); return clone(game);
    },
    async replace(id, revision, game) {
      const current = games.get(id);
      if (!current) throw missing();
      if (current.revision !== revision) throw stale();
      games.set(id, clone(game)); return clone(game);
    },
    close() {}
  };
}

/** Open the dedicated Pages database; startup failure is explicitly temporary. */
export async function createBrowserStore({ databaseName = 'yijing-gomoku-pages', indexedDB: supplied } = {}) {
  let factory;
  try { factory = supplied === undefined ? globalThis.indexedDB : supplied; } catch { return createMemoryStore(); }
  if (!factory?.open) return createMemoryStore();
  let db;
  try {
    db = await new Promise((resolve,reject) => {
      let request;
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('Storage unavailable')); },5000);
      try { request = factory.open(databaseName,1); } catch (error) { clearTimeout(timer);reject(error);return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('games')) request.result.createObjectStore('games',{keyPath:'id'});
      };
      request.onsuccess = () => { clearTimeout(timer); if(expired)request.result.close();else resolve(request.result); };
      request.onerror = () => {clearTimeout(timer);reject(request.error);};
      request.onblocked = () => {clearTimeout(timer);expired=true;reject(new Error('Storage blocked'));};
    });
  } catch { return createMemoryStore(); }
  db.onversionchange = () => db.close();
  function transaction(mode, task) {
    return new Promise((resolve,reject) => {
      let tx;
      try { tx = db.transaction('games',mode); } catch {
        reject(fail('STORAGE_UNAVAILABLE','浏览器存储已关闭，请刷新页面后重试。'));return;
      }
      let result, failure;
      const store = tx.objectStore('games');
      const abort = error => {failure=error;tx.abort();};
      const done = value => {result=value;};
      tx.oncomplete = () => resolve(clone(result));
      tx.onabort = () => reject(failure || fail('STORAGE_WRITE_FAILED','棋谱保存失败，浏览器空间可能已满。请导出已有棋谱后重试。'));
      tx.onerror = () => { /* onabort reports a fixed, credential-free message. */ };
      try {task(store,done,abort);}catch(error){abort(error);}
    });
  }
  return {
    storage:'indexeddb', storagePersistent:true,
    get(id) {return transaction('readonly',(store,done)=>{store.get(id).onsuccess=event=>done(event.target.result||null);});},
    list() {return transaction('readonly',(store,done)=>{store.getAll().onsuccess=event=>done(event.target.result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));});},
    create(game) {
      return transaction('readwrite',(store,done,abort)=>{
        store.count().onsuccess=event=>{
          if(event.target.result>=500){abort(full());return;}
          store.add(clone(game));done(game);
        };
      });
    },
    replace(id,revision,game) {
      return transaction('readwrite',(store,done,abort)=>{
        store.get(id).onsuccess=event=>{
          const current=event.target.result;
          if(!current){abort(missing());return;}
          if(current.revision!==revision){abort(stale());return;}
          store.put(clone(game));done(game);
        };
      });
    },
    close(){db.close();}
  };
}
