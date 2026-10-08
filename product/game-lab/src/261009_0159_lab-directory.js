import { DurableObject } from 'cloudflare:workers';

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_MS = 8 * 60 * 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
export async function hashToken(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
export async function secretMatches(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string' || !expected) return false;
  const hashes = await Promise.all([value, expected].map(text => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(...hashes);
  const a = new Uint8Array(hashes[0]), b = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

export class LabDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS directory_rooms (id TEXT PRIMARY KEY, title TEXT NOT NULL, track TEXT NOT NULL, phase TEXT NOT NULL, member_count INTEGER NOT NULL, stage TEXT, created_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS directory_created ON directory_rooms (created_at DESC, id DESC)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS directory_deleted (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS admin_attempts (ip_hash TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL)');
  }

  register(summary) {
    if (!summary || !ROOM_ID.test(summary.id) || !['lab', 'standard'].includes(summary.track)) return false;
    if (this.sql.exec('SELECT id FROM directory_deleted WHERE id = ?', summary.id).toArray().length) return false;
    this.sql.exec('INSERT INTO directory_rooms (id,title,track,phase,member_count,stage,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,track=excluded.track,phase=excluded.phase,member_count=excluded.member_count,stage=excluded.stage', summary.id, String(summary.title).slice(0, 80), summary.track, summary.phase, summary.memberCount || 0, summary.stage || null, summary.createdAt || Date.now());
    return true;
  }

  registerMany(summaries) {
    return this.ctx.storage.transactionSync(() => summaries.reduce((count, summary) => count + Number(this.register(summary)), 0));
  }

  list(limit = 25, cursor = null, query = '') {
    limit = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 25));
    const search = `%${query.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    let after = null;
    if (cursor) {
      try { after = JSON.parse(atob(cursor)); } catch { throw Object.assign(new Error('목록을 새로 불러와 주세요.'), { status: 400 }); }
      if (!Array.isArray(after) || !Number.isSafeInteger(after[0]) || !ROOM_ID.test(after[1])) throw Object.assign(new Error('목록을 새로 불러와 주세요.'), { status: 400 });
    }
    const rows = after
      ? this.sql.exec("SELECT * FROM directory_rooms WHERE title LIKE ? ESCAPE '\\' AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC,id DESC LIMIT ?", search, after[0], after[0], after[1], limit + 1).toArray()
      : this.sql.exec("SELECT * FROM directory_rooms WHERE title LIKE ? ESCAPE '\\' ORDER BY created_at DESC,id DESC LIMIT ?", search, limit + 1).toArray();
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      rooms: selected.map(row => ({ id: row.id, title: row.title, track: row.track, phase: row.phase, memberCount: row.member_count, stage: row.stage, createdAt: row.created_at })),
      nextCursor: rows.length > limit ? btoa(JSON.stringify([last.created_at, last.id])) : null,
      total: this.sql.exec("SELECT COUNT(*) AS total FROM directory_rooms WHERE title LIKE ? ESCAPE '\\'", search).toArray()[0].total
    };
  }

  remove(id, tombstone = true) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM directory_rooms WHERE id = ?', id);
      if (tombstone) this.sql.exec('INSERT INTO directory_deleted (id,deleted_at) VALUES (?,?) ON CONFLICT(id) DO NOTHING', id, Date.now());
    });
  }

  async login(password, ip) {
    const ipHash = await hashToken(ip);
    const now = Date.now();
    this.sql.exec('DELETE FROM admin_attempts WHERE window_start <= ?', now - WINDOW_MS);
    const attempt = this.sql.exec('SELECT failures,window_start FROM admin_attempts WHERE ip_hash = ?', ipHash).toArray()[0];
    if (attempt?.failures >= 5) return { status: 429, retryAfter: Math.ceil((attempt.window_start + WINDOW_MS - now) / 1000) };
    const valid = await secretMatches(password, this.env.NONOL_BASIC_KEY);
    const current = this.sql.exec('SELECT failures,window_start FROM admin_attempts WHERE ip_hash = ? AND window_start > ?', ipHash, Date.now() - WINDOW_MS).toArray()[0];
    if (current?.failures >= 5) return { status: 429, retryAfter: Math.ceil((current.window_start + WINDOW_MS - Date.now()) / 1000) };
    if (!valid) {
      this.sql.exec('INSERT INTO admin_attempts (ip_hash,failures,window_start) VALUES (?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET failures=admin_attempts.failures+1', ipHash, now);
      return { status: 401 };
    }
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await hashToken(token);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM admin_attempts WHERE ip_hash = ?', ipHash);
      this.sql.exec('DELETE FROM admin_sessions WHERE expires_at <= ?', Date.now());
      this.sql.exec('INSERT INTO admin_sessions (token_hash,expires_at) VALUES (?,?)', tokenHash, Date.now() + SESSION_MS);
    });
    return { status: 200, token };
  }

  async session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    const tokenHash = await hashToken(token);
    this.sql.exec('DELETE FROM admin_sessions WHERE expires_at <= ?', Date.now());
    return Boolean(this.sql.exec('SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?', tokenHash, Date.now()).toArray()[0]);
  }

  async logout(token) {
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) this.sql.exec('DELETE FROM admin_sessions WHERE token_hash = ?', await hashToken(token));
  }
}
