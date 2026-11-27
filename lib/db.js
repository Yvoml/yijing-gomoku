import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boardFromMoves, getWinner, isDraw } from './engine.js';

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'gomoku.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
      mode TEXT NOT NULL, difficulty TEXT NOT NULL, human_color INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', winner INTEGER,
      revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS games_owner_updated ON games(owner, updated_at DESC);
    CREATE TABLE IF NOT EXISTS moves (
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      number INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
      player INTEGER NOT NULL, feedback TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(game_id, number), UNIQUE(game_id, x, y)
    ); PRAGMA user_version=1;`);

  const rowToGame = row => {
    if (!row) return null;
    const moves = db.prepare('SELECT * FROM moves WHERE game_id=? ORDER BY number').all(row.id).map(m => ({
      ...JSON.parse(m.feedback), number: m.number, x: m.x, y: m.y, player: m.player, createdAt: m.created_at
    }));
    return {
      id: row.id, title: row.title, mode: row.mode, difficulty: row.difficulty,
      humanColor: row.human_color, status: row.status, winner: row.winner,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      moves, board: boardFromMoves(moves), currentPlayer: moves.length % 2 ? 2 : 1
    };
  };
  const get = (owner, id) => rowToGame(db.prepare('SELECT * FROM games WHERE owner=? AND id=?').get(owner,id));
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    close() { db.close(); },
    get,
    list(owner) {
      return db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM moves m WHERE m.game_id=g.id) AS move_count
        FROM games g WHERE owner=? ORDER BY updated_at DESC LIMIT 200`).all(owner).map(row => ({
        id:row.id,title:row.title,mode:row.mode,difficulty:row.difficulty,humanColor:row.human_color,
        status:row.status,winner:row.winner,moveCount:row.move_count,createdAt:row.created_at,updatedAt:row.updated_at
      }));
    },
    create(owner, { mode, difficulty, humanColor }) {
      const id = randomUUID(); const now = new Date().toISOString();
      const count = db.prepare('SELECT COUNT(*) AS n FROM games WHERE owner=?').get(owner).n;
      if (count >= 500) throw Object.assign(new Error('当前浏览器已达到 500 局存储上限，请导出已有棋谱。'), { status:429, code:'GAME_LIMIT' });
      const title = `${mode === 'ai' ? '人机对弈' : '双人对弈'} · ${new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())}`;
      db.prepare('INSERT INTO games (id,owner,title,mode,difficulty,human_color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,owner,title,mode,difficulty,humanColor,now,now);
      return get(owner,id);
    },
    append(owner,id,revision,{x,y,player},feedback) {
      return transaction(() => {
        const game = get(owner,id);
        if (!game || game.revision !== revision) throw Object.assign(new Error('对局已改变，请刷新后重试。'),{status:409,code:'STALE_GAME'});
        if (game.status !== 'active' || game.board[y]?.[x] !== 0 || game.currentPlayer !== player) throw Object.assign(new Error('当前落子不合法。'),{status:409,code:'ILLEGAL_MOVE'});
        const now = new Date().toISOString();
        db.prepare('INSERT INTO moves (game_id,number,x,y,player,feedback,created_at) VALUES (?,?,?,?,?,?,?)').run(id,game.moves.length+1,x,y,player,JSON.stringify(feedback),now);
        game.board[y][x] = player;
        const winner = getWinner(game.board,x,y);
        const status = winner ? 'won' : isDraw(game.board) ? 'draw' : 'active';
        db.prepare('UPDATE games SET status=?,winner=?,updated_at=?,revision=revision+1 WHERE id=?').run(status,winner || null,now,id);
        return get(owner,id);
      });
    },
    undo(owner,id) {
      return transaction(() => {
        const game = get(owner,id);
        if (!game?.moves.length) return game;
        // Undo through the most recent human move, including its AI reply.
        let keep = game.moves.length-1;
        if (game.mode === 'ai') {
          const humanIndex = game.moves.findLastIndex(m=>m.player===game.humanColor);
          keep = humanIndex < 0 ? 0 : humanIndex;
        }
        db.prepare('DELETE FROM moves WHERE game_id=? AND number>?').run(id,keep);
        db.prepare("UPDATE games SET status='active',winner=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(new Date().toISOString(),id);
        return get(owner,id);
      });
    }
  };
}
