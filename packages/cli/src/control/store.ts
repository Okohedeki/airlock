/**
 * Durable, file-backed persistence for the airlock Control Plane.
 *
 * Real (not seeded) state lives under `<root>/.airlock-control/`:
 *   - control.json  — users, SSO config, environments + policy, worker→env assignment
 *   - audit.jsonl   — append-only, one JSON event per line (immutable history, survives restart)
 *
 * On first run the store is seeded from seed.ts so the dashboard is populated; thereafter it is
 * real: edits persist and the audit log only ever appends. No external DB dependency.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENVIRONMENTS, SSO, USERS, type User } from './seed.js';

export interface EnvPolicy { minRole: string; changeControl: boolean; }
export interface ControlState {
  users: (User & { password?: string })[];
  sso: typeof SSO & { oidcIssuer?: string; oidcClientId?: string };
  environments: typeof ENVIRONMENTS;
  envPolicy: Record<string, EnvPolicy>;
  workerEnv: Record<string, string>; // worker id → environment id
}
export interface AuditEntry { ts: number; actor: string; action: string; target: string; env: string; detail: string; }

const DEFAULT_POLICY: Record<string, EnvPolicy> = {
  prod: { minRole: 'operator', changeControl: true },
  staging: { minRole: 'operator', changeControl: false },
  dev: { minRole: 'viewer', changeControl: false },
};

export class ControlStore {
  readonly dir: string;
  private cFile: string;
  private aFile: string;
  private state: ControlState;

  constructor(root: string) {
    this.dir = join(root, '.airlock-control');
    this.cFile = join(this.dir, 'control.json');
    this.aFile = join(this.dir, 'audit.jsonl');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.state = this.loadOrSeed();
  }

  private loadOrSeed(): ControlState {
    if (existsSync(this.cFile)) {
      try {
        return JSON.parse(readFileSync(this.cFile, 'utf8')) as ControlState;
      } catch {
        /* fall through to seed */
      }
    }
    const seeded: ControlState = {
      users: USERS.map((u) => ({ ...u })),
      sso: { ...SSO },
      environments: ENVIRONMENTS,
      envPolicy: DEFAULT_POLICY,
      workerEnv: {},
    };
    writeFileSync(this.cFile, JSON.stringify(seeded, null, 2));
    // Audit log starts EMPTY and only ever appends real actions (no fabricated history).
    if (!existsSync(this.aFile)) writeFileSync(this.aFile, '');
    return seeded;
  }

  private persist(): void {
    writeFileSync(this.cFile, JSON.stringify(this.state, null, 2));
  }

  // ---- control state ----
  get(): ControlState { return this.state; }
  users(): ControlState['users'] { return this.state.users; }
  sso() { return this.state.sso; }
  environments() { return this.state.environments; }
  envPolicy(envId: string): EnvPolicy { return this.state.envPolicy[envId] || { minRole: 'viewer', changeControl: false }; }
  workerEnv(id: string): string { return this.state.workerEnv[id] || 'dev'; }

  setWorkerEnv(id: string, env: string): void { this.state.workerEnv[id] = env; this.persist(); }
  setUserRole(email: string, role: string): boolean {
    const u = this.state.users.find((x) => x.email === email);
    if (!u) return false;
    u.role = role; this.persist(); return true;
  }
  addUser(u: User): void {
    if (!this.state.users.some((x) => x.email === u.email)) { this.state.users.push({ ...u }); this.persist(); }
  }
  setSso(patch: Partial<ControlState['sso']>): void { this.state.sso = { ...this.state.sso, ...patch }; this.persist(); }

  // ---- audit (append-only) ----
  appendAudit(e: Omit<AuditEntry, 'ts'>): void {
    appendFileSync(this.aFile, JSON.stringify({ ts: Date.now(), ...e }) + '\n');
  }
  readAudit(limit = 200): AuditEntry[] {
    if (!existsSync(this.aFile)) return [];
    const lines = readFileSync(this.aFile, 'utf8').split('\n').filter(Boolean);
    const out: AuditEntry[] = [];
    for (const ln of lines) { try { out.push(JSON.parse(ln)); } catch { /* skip */ } }
    return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }
}
