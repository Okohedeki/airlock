/**
 * The Fleet Router — frozen contract C4 (ADR-0017, epic 09).
 *
 * One ordered pipeline of pluggable stages in front of the worker fleet:
 *
 *   1. authResolveTenant   (epic 10)  resolve tenant; reject unauth
 *   2. selectVersion       (epic 08)  stable vs canary — STICKINESS WINS OVER CANARY
 *   3. selectVariant       (epic 12)  capability -> cost -> latency
 *   4. stickyAffinity      (epic 04)  pin session -> replica
 *   5. loadBalance         (epic 09)  pick a healthy replica
 *
 * Control stays INSIDE each worker (the Loop Engine owns the loop); the router only
 * decides WHICH worker handles a request. Triggers (epic 11) enter at stage 2.
 *
 * The registry here is in-memory (single-box / demo); the runtime backs it with the
 * State Store under `_system/...` (frozen contract C3) for multi-replica fleets.
 */

export interface WorkerRecord {
  id: string;
  name: string;
  version: string;
  variant: string;
  host: string;
  port: number;
  capabilities: string[];
  costEstimate: number;
  latencyMs: number;
  healthy: boolean;
  inflight: number;
}

export interface Rollout {
  stable: string;
  canary?: { version: string; pct: number };
}

export interface RouteRequest {
  sessionId?: string;
  apiKey?: string;
  capability?: string; // desired variant capability (epic 12)
  worker: string; // logical worker name
}

export interface RouteContext {
  request: RouteRequest;
  tenant?: string;
  version?: string;
  variant?: string;
  target?: WorkerRecord;
  trace: string[];
}

export type Stage = (ctx: RouteContext, next: () => Promise<void>) => Promise<void>;

/** A 32-bit FNV-ish hash → stable bucket for canary assignment (no Math.random). */
function bucket(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100;
}

export class Registry {
  workers: WorkerRecord[] = [];
  rollouts = new Map<string, Rollout>();
  apiKeys = new Map<string, string>(); // key -> tenant
  private sessionVersion = new Map<string, string>(); // sticky version pin (C4)
  private sessionReplica = new Map<string, string>(); // sticky replica pin (epic 04)
  private rr = 0;

  register(w: Omit<WorkerRecord, 'inflight' | 'healthy'> & Partial<Pick<WorkerRecord, 'healthy'>>): void {
    this.workers.push({ inflight: 0, healthy: w.healthy ?? true, ...w });
  }

  setRollout(worker: string, rollout: Rollout): void {
    this.rollouts.set(worker, rollout);
  }

  /** Sticky version pin: read it (honor) or set it once. Stickiness wins over canary. */
  pinVersion(sessionId: string | undefined, decide: () => string): string {
    if (!sessionId) return decide(); // anonymous: bucket per request, never pinned
    const existing = this.sessionVersion.get(sessionId);
    if (existing) return existing; // pinned — a live session never flips version
    const chosen = decide();
    this.sessionVersion.set(sessionId, chosen);
    return chosen;
  }

  pinReplica(sessionId: string | undefined, candidates: WorkerRecord[]): WorkerRecord | undefined {
    if (sessionId) {
      const pinned = this.sessionReplica.get(sessionId);
      const found = pinned && candidates.find((w) => w.id === pinned);
      if (found) return found;
    }
    if (candidates.length === 0) return undefined;
    const pick = candidates[this.rr++ % candidates.length]!;
    if (sessionId) this.sessionReplica.set(sessionId, pick.id);
    return pick;
  }
}

// ---- the five frozen stages -------------------------------------------------

export const authResolveTenant = (reg: Registry): Stage => async (ctx, next) => {
  const key = ctx.request.apiKey;
  if (reg.apiKeys.size > 0) {
    if (!key || !reg.apiKeys.has(key)) throw new Error('401: unauthenticated');
    ctx.tenant = reg.apiKeys.get(key);
  } else {
    ctx.tenant = 'default';
  }
  ctx.trace.push(`1 tenant=${ctx.tenant}`);
  await next();
};

export const selectVersion = (reg: Registry): Stage => async (ctx, next) => {
  const rollout = reg.rollouts.get(ctx.request.worker);
  ctx.version = reg.pinVersion(ctx.request.sessionId, () => {
    if (rollout?.canary && bucket(`${ctx.request.sessionId ?? Math.random()}|v`) < rollout.canary.pct) {
      return rollout.canary.version;
    }
    return rollout?.stable ?? '0.0.0';
  });
  ctx.trace.push(`2 version=${ctx.version}`);
  await next();
};

export const selectVariant = (reg: Registry): Stage => async (ctx, next) => {
  const want = ctx.request.capability;
  let pool = reg.workers.filter((w) => w.version === ctx.version);
  if (want) {
    const matching = pool.filter((w) => w.capabilities.includes(want));
    if (matching.length) pool = matching; // capability is a hard filter
  }
  // tie-break: lowest cost, then lowest latency
  const best = [...pool].sort((a, b) => a.costEstimate - b.costEstimate || a.latencyMs - b.latencyMs)[0];
  ctx.variant = best?.variant;
  ctx.trace.push(`3 variant=${ctx.variant ?? 'none'}`);
  await next();
};

export const stickyAndBalance = (reg: Registry): Stage => async (ctx, next) => {
  // Stages 4+5: candidates = healthy replicas of the chosen version+variant.
  const candidates = reg.workers.filter(
    (w) => w.healthy && w.version === ctx.version && (!ctx.variant || w.variant === ctx.variant),
  );
  ctx.target = reg.pinReplica(ctx.request.sessionId, candidates);
  if (!ctx.target) throw new Error('503: no healthy target');
  ctx.target.inflight++;
  ctx.trace.push(`4+5 target=${ctx.target.id}@${ctx.target.host}:${ctx.target.port}`);
  await next();
};

/** Run the stages in the frozen order. */
export function createRouter(reg: Registry): (req: RouteRequest) => Promise<RouteContext> {
  const stages: Stage[] = [
    authResolveTenant(reg),
    selectVersion(reg),
    selectVariant(reg),
    stickyAndBalance(reg),
  ];
  return async (request: RouteRequest) => {
    const ctx: RouteContext = { request, trace: [] };
    let i = 0;
    const next = async (): Promise<void> => {
      const stage = stages[i++];
      if (stage) await stage(ctx, next);
    };
    await next();
    return ctx;
  };
}
