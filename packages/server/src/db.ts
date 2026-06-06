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
  archived_at: number | null;
}

export interface CliTokenSummary {
  id: number; // sqlite rowid; opaque handle, never the secret token
  token_prefix: string; // first 8 chars, for identification only
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
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
}

export interface ProjectStats {
  total_calls: number;
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
      created_at INTEGER NOT NULL,
      label TEXT,
      last_used_at INTEGER,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('workers','fly')),
      created_at INTEGER NOT NULL,
      archived_at INTEGER,
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
      tokens_used INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_inspect_project_time
      ON inspect_calls(project_id, timestamp DESC);
  `);
  // Forward-compatibility: add columns missing from older DBs. (Older DBs may
  // also carry extra columns from a prior schema — those are simply ignored.)
  ensureColumn(db, 'projects', 'archived_at', 'INTEGER');
  ensureColumn(db, 'cli_tokens', 'revoked_at', 'INTEGER');
  ensureColumn(db, 'cli_tokens', 'label', 'TEXT');
  ensureColumn(db, 'cli_tokens', 'last_used_at', 'INTEGER');
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
  /** Soft-delete: sets archived_at to now. Returns true if a row was touched. */
  archiveProject(userId: number, id: number): boolean;
  recordInspectCall(project_id: number, call: Omit<InspectCall, 'id' | 'project_id'>): void;
  listInspectCalls(projectId: number, limit?: number): InspectCall[];
  getInspectCall(projectId: number, callId: number): InspectCall | null;
  getProjectStats(projectId: number): ProjectStats;
  listCliTokens(userId: number): CliTokenSummary[];
  /** Soft-revokes by sqlite rowid. Returns true if a row was touched. */
  revokeCliToken(userId: number, tokenRowId: number): boolean;
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
        .prepare(
          'SELECT u.* FROM users u JOIN cli_tokens t ON t.user_id = u.id WHERE t.token = ? AND t.revoked_at IS NULL',
        )
        .get(token) as User | undefined;
      if (!row) return null;
      db.prepare('UPDATE cli_tokens SET last_used_at = ? WHERE token = ?').run(Date.now(), token);
      return row;
    },

    listProjects(userId) {
      return db
        .prepare(
          'SELECT * FROM projects WHERE user_id = ? AND archived_at IS NULL ORDER BY created_at DESC',
        )
        .all(userId) as Project[];
    },

    upsertProject(userId, name, target) {
      const existing = db
        .prepare('SELECT * FROM projects WHERE user_id = ? AND name = ?')
        .get(userId, name) as Project | undefined;
      if (existing) {
        // Sync after archive un-archives. Update target if it diverged.
        if (existing.target !== target || existing.archived_at !== null) {
          db.prepare('UPDATE projects SET target = ?, archived_at = NULL WHERE id = ?').run(
            target,
            existing.id,
          );
        }
        return { ...existing, target, archived_at: null };
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
        archived_at: null,
      };
    },

    getProject(userId, id) {
      const row = db
        .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
        .get(id, userId) as Project | undefined;
      return row ?? null;
    },

    archiveProject(userId, id) {
      const result = db
        .prepare(
          'UPDATE projects SET archived_at = ? WHERE id = ? AND user_id = ? AND archived_at IS NULL',
        )
        .run(Date.now(), id, userId);
      return result.changes > 0;
    },

    recordInspectCall(project_id, call) {
      db.prepare(
        `INSERT INTO inspect_calls
          (project_id, timestamp, caller, status, request_url, request_body, response_body, tokens_used)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        project_id,
        call.timestamp,
        call.caller,
        call.status,
        call.request_url,
        call.request_body,
        call.response_body,
        call.tokens_used,
      );
    },

    listInspectCalls(projectId, limit = 50) {
      return db
        .prepare('SELECT * FROM inspect_calls WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?')
        .all(projectId, limit) as InspectCall[];
    },

    getInspectCall(projectId, callId) {
      const row = db
        .prepare('SELECT * FROM inspect_calls WHERE id = ? AND project_id = ?')
        .get(callId, projectId) as InspectCall | undefined;
      return row ?? null;
    },

    listCliTokens(userId) {
      const rows = db
        .prepare(
          'SELECT rowid AS id, token, label, created_at, last_used_at, revoked_at FROM cli_tokens WHERE user_id = ? ORDER BY created_at DESC',
        )
        .all(userId) as {
        id: number;
        token: string;
        label: string | null;
        created_at: number;
        last_used_at: number | null;
        revoked_at: number | null;
      }[];
      return rows.map((r) => ({
        id: r.id,
        token_prefix: r.token.slice(0, 8),
        label: r.label,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
        revoked_at: r.revoked_at,
      }));
    },

    revokeCliToken(userId, tokenRowId) {
      const result = db
        .prepare(
          'UPDATE cli_tokens SET revoked_at = ? WHERE rowid = ? AND user_id = ? AND revoked_at IS NULL',
        )
        .run(Date.now(), tokenRowId, userId);
      return result.changes > 0;
    },

    getProjectStats(projectId) {
      const agg = db
        .prepare(
          `SELECT
              COUNT(*) AS total_calls,
              COALESCE(SUM(tokens_used), 0) AS total_tokens,
              MAX(timestamp) AS last_call_at,
              COUNT(DISTINCT caller) AS unique_callers
           FROM inspect_calls WHERE project_id = ?`,
        )
        .get(projectId) as {
        total_calls: number;
        total_tokens: number;
        last_call_at: number | null;
        unique_callers: number;
      };

      return {
        total_calls: agg.total_calls,
        unique_callers: agg.unique_callers,
        total_tokens: agg.total_tokens,
        last_call_at: agg.last_call_at,
      };
    },
  };
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
