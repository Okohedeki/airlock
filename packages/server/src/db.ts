import Database from 'better-sqlite3';

export interface User {
  id: number;
  github_id: number;
  github_login: string;
  avatar_url: string | null;
  created_at: number;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  user_id: number | null;
  status: 'pending' | 'approved' | 'expired';
  expires_at: number;
}

export interface Project {
  id: number;
  user_id: number;
  name: string;
  target: 'workers' | 'fly';
  created_at: number;
}

export interface InspectCall {
  id: number;
  project_id: number;
  timestamp: number;
  caller: string | null;
  status: number;
  request_url: string;
  request_body: string | null;
  response_body: string | null;
  tokens_used: number | null;
  amount_usdc: string | null;
  payment_settled: number; // boolean
}

export interface ProjectStats {
  total_calls: number;
  paid_calls: number;
  total_revenue_usdc: string;
  unique_callers: number;
  total_tokens: number;
  last_call_at: number | null;
}

/** Open a SQLite DB and run the schema migration. Idempotent. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id INTEGER NOT NULL UNIQUE,
      github_login TEXT NOT NULL,
      avatar_url TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_codes (
      device_code TEXT PRIMARY KEY,
      user_code TEXT NOT NULL UNIQUE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at INTEGER NOT NULL,
      access_token TEXT
    );

    CREATE TABLE IF NOT EXISTS cli_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('workers','fly')),
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS inspect_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL,
      caller TEXT,
      status INTEGER NOT NULL,
      request_url TEXT NOT NULL,
      request_body TEXT,
      response_body TEXT,
      tokens_used INTEGER,
      amount_usdc TEXT,
      payment_settled INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_inspect_project_time
      ON inspect_calls(project_id, timestamp DESC);
  `);
  // Forward-compatibility: add columns missing from older DBs.
  ensureColumn(db, 'inspect_calls', 'amount_usdc', 'TEXT');
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export interface DbHandle {
  db: Database.Database;
  upsertUser(github: { id: number; login: string; avatar_url?: string }): User;
  createSession(userId: number, ttlSeconds: number): string;
  getUserBySession(sessionId: string): User | null;
  deleteSession(sessionId: string): void;
  createDeviceCode(ttlSeconds: number): DeviceCode;
  approveDeviceCode(userCode: string, userId: number): boolean;
  pollDeviceCode(deviceCode: string): { status: string; cliToken?: string };
  getUserByCliToken(token: string): User | null;
  listProjects(userId: number): Project[];
  upsertProject(userId: number, name: string, target: 'workers' | 'fly'): Project;
  getProject(userId: number, id: number): Project | null;
  recordInspectCall(project_id: number, call: Omit<InspectCall, 'id' | 'project_id'>): void;
  listInspectCalls(projectId: number, limit?: number): InspectCall[];
  getProjectStats(projectId: number): ProjectStats;
}

export function makeDbHandle(db: Database.Database): DbHandle {
  return {
    db,

    upsertUser(gh) {
      const now = Date.now();
      const existing = db.prepare('SELECT * FROM users WHERE github_id = ?').get(gh.id) as
        | User
        | undefined;
      if (existing) {
        db.prepare('UPDATE users SET github_login = ?, avatar_url = ? WHERE id = ?').run(
          gh.login,
          gh.avatar_url ?? null,
          existing.id,
        );
        return { ...existing, github_login: gh.login, avatar_url: gh.avatar_url ?? null };
      }
      const result = db
        .prepare(
          'INSERT INTO users (github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(gh.id, gh.login, gh.avatar_url ?? null, now);
      return {
        id: result.lastInsertRowid as number,
        github_id: gh.id,
        github_login: gh.login,
        avatar_url: gh.avatar_url ?? null,
        created_at: now,
      };
    },

    createSession(userId, ttlSeconds) {
      const id = randHex(32);
      const expiresAt = Date.now() + ttlSeconds * 1000;
      db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
        id,
        userId,
        expiresAt,
      );
      return id;
    },

    getUserBySession(sessionId) {
      const row = db
        .prepare(
          'SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.id = ? AND s.expires_at > ?',
        )
        .get(sessionId, Date.now()) as User | undefined;
      return row ?? null;
    },

    deleteSession(sessionId) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    },

    createDeviceCode(ttlSeconds) {
      const device_code = randHex(32);
      const user_code = randUserCode();
      const expires_at = Date.now() + ttlSeconds * 1000;
      db.prepare(
        'INSERT INTO device_codes (device_code, user_code, expires_at, status) VALUES (?, ?, ?, ?)',
      ).run(device_code, user_code, expires_at, 'pending');
      return { device_code, user_code, user_id: null, status: 'pending', expires_at };
    },

    approveDeviceCode(userCode, userId) {
      const row = db
        .prepare('SELECT device_code FROM device_codes WHERE user_code = ? AND status = ?')
        .get(userCode, 'pending') as { device_code: string } | undefined;
      if (!row) return false;
      db.prepare(
        'UPDATE device_codes SET status = ?, user_id = ?, access_token = ? WHERE device_code = ?',
      ).run('approved', userId, randHex(32), row.device_code);
      return true;
    },

    pollDeviceCode(deviceCode) {
      const row = db.prepare('SELECT * FROM device_codes WHERE device_code = ?').get(deviceCode) as
        | {
            status: string;
            user_id: number | null;
            access_token: string | null;
            expires_at: number;
          }
        | undefined;
      if (!row) return { status: 'not_found' };
      if (Date.now() > row.expires_at && row.status === 'pending') return { status: 'expired' };
      if (row.status !== 'approved' || !row.user_id || !row.access_token) {
        return { status: row.status };
      }
      // Mint a CLI token tied to this user
      db.prepare('INSERT INTO cli_tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(
        row.access_token,
        row.user_id,
        Date.now(),
      );
      // Burn the device code so it can't be redeemed twice
      db.prepare('UPDATE device_codes SET status = ? WHERE device_code = ?').run(
        'consumed',
        deviceCode,
      );
      return { status: 'approved', cliToken: row.access_token };
    },

    getUserByCliToken(token) {
      const row = db
        .prepare('SELECT u.* FROM users u JOIN cli_tokens t ON t.user_id = u.id WHERE t.token = ?')
        .get(token) as User | undefined;
      return row ?? null;
    },

    listProjects(userId) {
      return db
        .prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC')
        .all(userId) as Project[];
    },

    upsertProject(userId, name, target) {
      const existing = db
        .prepare('SELECT * FROM projects WHERE user_id = ? AND name = ?')
        .get(userId, name) as Project | undefined;
      if (existing) {
        if (existing.target !== target) {
          db.prepare('UPDATE projects SET target = ? WHERE id = ?').run(target, existing.id);
        }
        return { ...existing, target };
      }
      const now = Date.now();
      const result = db
        .prepare('INSERT INTO projects (user_id, name, target, created_at) VALUES (?, ?, ?, ?)')
        .run(userId, name, target, now);
      return {
        id: result.lastInsertRowid as number,
        user_id: userId,
        name,
        target,
        created_at: now,
      };
    },

    getProject(userId, id) {
      const row = db
        .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
        .get(id, userId) as Project | undefined;
      return row ?? null;
    },

    recordInspectCall(project_id, call) {
      db.prepare(
        `INSERT INTO inspect_calls
          (project_id, timestamp, caller, status, request_url, request_body, response_body, tokens_used, amount_usdc, payment_settled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        project_id,
        call.timestamp,
        call.caller,
        call.status,
        call.request_url,
        call.request_body,
        call.response_body,
        call.tokens_used,
        call.amount_usdc,
        call.payment_settled,
      );
    },

    listInspectCalls(projectId, limit = 50) {
      return db
        .prepare('SELECT * FROM inspect_calls WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?')
        .all(projectId, limit) as InspectCall[];
    },

    getProjectStats(projectId) {
      const agg = db
        .prepare(
          `SELECT
              COUNT(*) AS total_calls,
              COALESCE(SUM(payment_settled), 0) AS paid_calls,
              COALESCE(SUM(tokens_used), 0) AS total_tokens,
              MAX(timestamp) AS last_call_at,
              COUNT(DISTINCT caller) AS unique_callers
           FROM inspect_calls WHERE project_id = ?`,
        )
        .get(projectId) as {
        total_calls: number;
        paid_calls: number;
        total_tokens: number;
        last_call_at: number | null;
        unique_callers: number;
      };

      // Sum USDC decimal strings in atomic units, then convert back.
      const amounts = db
        .prepare(
          'SELECT amount_usdc FROM inspect_calls WHERE project_id = ? AND payment_settled = 1 AND amount_usdc IS NOT NULL',
        )
        .all(projectId) as { amount_usdc: string }[];
      let revenueAtomic = 0n;
      for (const row of amounts) {
        revenueAtomic += usdcToAtomic(row.amount_usdc);
      }

      return {
        total_calls: agg.total_calls,
        paid_calls: agg.paid_calls,
        total_revenue_usdc: atomicToUsdc(revenueAtomic),
        unique_callers: agg.unique_callers,
        total_tokens: agg.total_tokens,
        last_call_at: agg.last_call_at,
      };
    },
  };
}

function usdcToAtomic(usdc: string): bigint {
  const [whole, frac = ''] = usdc.split('.');
  return BigInt(`${whole}${`${frac}000000`.slice(0, 6)}`);
}

function atomicToUsdc(atomic: bigint): string {
  const s = atomic.toString().padStart(7, '0');
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randUserCode(): string {
  // 8-char display code like "XQ4F-7M2P"
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(8);
  globalThis.crypto.getRandomValues(buf);
  const chars = Array.from(buf, (b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
