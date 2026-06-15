/**
 * Representative enterprise dataset for the airlock Control Plane dashboard.
 *
 * The runtime today exposes real per-worker data (workers, runs, metrics, control plane,
 * approvals, tenants, versions, exposure). Enterprise governance also needs a fleet across
 * ENVIRONMENTS, RBAC users/roles/SSO, an immutable AUDIT LOG, and historical cost/latency —
 * none of which the runtime persists yet. This module supplies that as DETERMINISTIC,
 * clearly-labeled representative data so the full IA is coherent. Live data is overlaid on top
 * of it by server.ts; every seeded record carries `sample: true` so the UI can mark it.
 *
 * Deterministic by construction: a fixed-seed PRNG drives all variation, so screenshots and
 * demos are stable. Time-relative series take `now` as a parameter (computed at request time).
 */

export interface Env { id: string; label: string; tone: string; }
export const ENVIRONMENTS: Env[] = [
  { id: 'prod', label: 'Production', tone: 'indigo' },
  { id: 'staging', label: 'Staging', tone: 'amber' },
  { id: 'dev', label: 'Development', tone: 'slate' },
];

export interface Role { id: string; label: string; desc: string; perms: string[]; }
export const ROLES: Role[] = [
  { id: 'owner', label: 'Owner', desc: 'Full control including billing, access & exposure', perms: ['*'] },
  { id: 'operator', label: 'Operator', desc: 'Deploy, control, version, expose, approve', perms: ['workers:*', 'runs:*', 'approvals:*', 'exposure:*', 'versions:*'] },
  { id: 'approver', label: 'Approver', desc: 'Decide held runs; read fleet', perms: ['approvals:decide', 'runs:read', 'workers:read'] },
  { id: 'auditor', label: 'Auditor', desc: 'Read-only across the fleet and the audit log', perms: ['*:read', 'audit:read'] },
  { id: 'viewer', label: 'Viewer', desc: 'Read-only dashboards', perms: ['overview:read', 'workers:read', 'runs:read'] },
];

export interface User { id: string; name: string; email: string; role: string; sso: boolean; lastActiveMins: number; }
export const USERS: User[] = [
  { id: 'u-amaya', name: 'Amaya Okonkwo', email: 'amaya.okonkwo@acme.com', role: 'owner', sso: true, lastActiveMins: 4 },
  { id: 'u-dwyer', name: 'Sean Dwyer', email: 'sean.dwyer@acme.com', role: 'operator', sso: true, lastActiveMins: 12 },
  { id: 'u-reyes', name: 'Lucia Reyes', email: 'lucia.reyes@acme.com', role: 'operator', sso: true, lastActiveMins: 38 },
  { id: 'u-haddad', name: 'Omar Haddad', email: 'omar.haddad@acme.com', role: 'approver', sso: true, lastActiveMins: 73 },
  { id: 'u-stern', name: 'Dana Stern', email: 'dana.stern@acme.com', role: 'auditor', sso: true, lastActiveMins: 210 },
  { id: 'u-iqbal', name: 'Priya Iqbal', email: 'priya.iqbal@acme.com', role: 'viewer', sso: false, lastActiveMins: 1440 },
];

// enforced:false by default so local session login works out of the box; flipping it on requires
// a configured OIDC issuer (real external IdP) — the SSO path is otherwise unavailable.
export const SSO = { provider: 'Okta', protocol: 'SAML 2.0', domain: 'acme.com', enforced: false, scimProvisioning: true, mfa: 'required' };

export interface Tenant {
  id: string; name: string; plan: string; status: string; keyPrefix: string;
  rps: number; runs24h: number; tokens24h: number; costMtd: number; limitRps: number;
}
const TENANT_NAMES = [
  ['Globex Financial', 'Enterprise'], ['Acme Health Systems', 'Enterprise'], ['Initech Insurance', 'Enterprise'],
  ['Umbrella Logistics', 'Business'], ['Soylent Retail', 'Business'], ['Hooli Telecom', 'Enterprise'],
  ['Stark Industrial', 'Business'], ['Wayne Capital', 'Enterprise'], ['Wonka Foods', 'Business'],
  ['Cyberdyne Robotics', 'Business'], ['Tyrell Bio', 'Enterprise'], ['Massive Dynamic', 'Business'],
  ['Nakatomi Trading', 'Business'], ['Pied Piper Data', 'Startup'],
];

export interface FleetWorker {
  id: string; name: string; env: string; harness: string; expose: string; version: string;
  health: string; replicas: number; rps: number; p95: number; errPct: number; cost24h: number;
  owner: string; tenants: number; sample: true;
}
const AGENT_NAMES = [
  'claims-adjudicator', 'kyc-screening', 'fraud-review', 'support-triage', 'contract-analyzer',
  'underwriting-copilot', 'returns-resolver', 'invoice-matcher', 'onboarding-concierge',
  'risk-summarizer', 'dispute-handler', 'sanctions-screen', 'policy-explainer', 'churn-responder',
  'order-router', 'incident-triage', 'compliance-qa', 'lead-qualifier',
];
const HARNESSES = ['langgraph', 'crewai', 'openai-agents', 'claude', 'smolagents', 'openai'];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const pick = <T>(r: () => number, a: T[]): T => a[Math.floor(r() * a.length)] as T;

/** A deterministic representative fleet across environments. */
export function fleet(): FleetWorker[] {
  const r = rng(0x5eed);
  const out: FleetWorker[] = [];
  AGENT_NAMES.forEach((name, i) => {
    const env = i < 11 ? 'prod' : i < 15 ? 'staging' : 'dev';
    const errPct = Math.round(r() * (env === 'prod' ? 12 : 40)) / 10;
    const health = errPct > 3 ? 'degraded' : errPct > 6 ? 'error' : 'healthy';
    out.push({
      id: `seed:${name}`, name, env, harness: pick(r, HARNESSES),
      expose: r() > 0.35 ? 'public' : 'internal',
      version: `v${1 + Math.floor(r() * 3)}.${Math.floor(r() * 9)}.${Math.floor(r() * 9)}`,
      health, replicas: env === 'prod' ? 2 + Math.floor(r() * 6) : 1 + Math.floor(r() * 2),
      rps: Math.round(r() * (env === 'prod' ? 240 : 30) * 10) / 10,
      p95: 280 + Math.floor(r() * 2600), errPct,
      cost24h: Math.round(r() * (env === 'prod' ? 900 : 80) * 100) / 100,
      owner: pick(r, USERS.filter((u) => u.role === 'operator').map((u) => u.name)),
      tenants: 1 + Math.floor(r() * 9), sample: true,
    });
  });
  return out;
}

export function tenants(): Tenant[] {
  const r = rng(0x7e7a);
  return TENANT_NAMES.map(([name, plan], i) => {
    const rps = Math.round(r() * (plan === 'Enterprise' ? 90 : 20) * 10) / 10;
    return {
      id: `tn-${i}`, name: name as string, plan: plan as string,
      status: r() > 0.08 ? 'active' : 'suspended',
      keyPrefix: `ak_${(name as string).slice(0, 3).toLowerCase()}_${(1000 + Math.floor(r() * 8999))}`,
      rps, runs24h: Math.floor(r() * (plan === 'Enterprise' ? 90000 : 9000)),
      tokens24h: Math.floor(r() * (plan === 'Enterprise' ? 42 : 6) * 1e6),
      costMtd: Math.round(r() * (plan === 'Enterprise' ? 38000 : 4000) * 100) / 100,
      limitRps: plan === 'Enterprise' ? 250 : plan === 'Business' ? 60 : 15,
    };
  });
}

export interface AuditEvent { id: string; tsMins: number; actor: string; action: string; target: string; env: string; detail: string; sample?: boolean; }
const AUDIT_TEMPLATES: Array<[string, string, string, string]> = [
  ['Sean Dwyer', 'version.promote', 'fraud-review', 'promoted v2.4.1 → 100% (canary cleared)'],
  ['Lucia Reyes', 'exposure.flip', 'kyc-screening', 'internal → public (Cloudflare tunnel opened)'],
  ['Omar Haddad', 'approval.approve', 'claims-adjudicator/run_8c21', 'approved tool send → customer@globex'],
  ['Amaya Okonkwo', 'access.role_change', 'priya.iqbal@acme.com', 'Viewer → Approver'],
  ['Sean Dwyer', 'control.skill_disable', 'support-triage', 'disabled skill refund (tool dropped from loop)'],
  ['Omar Haddad', 'approval.deny', 'sanctions-screen/run_4f0a', 'denied tool transfer — flagged for review'],
  ['Lucia Reyes', 'control.guard', 'underwriting-copilot', 'budget.usd 0.50 → 0.20'],
  ['Dana Stern', 'audit.export', 'prod', 'exported 30d audit log (SOC2)'],
  ['Sean Dwyer', 'version.rollback', 'returns-resolver', 'instant rollback v3.1.0 → v3.0.4'],
  ['Lucia Reyes', 'control.model_route', 'contract-analyzer', 'routing default fast → primary'],
  ['Amaya Okonkwo', 'tenant.suspend', 'Pied Piper Data', 'suspended — rate-limit abuse'],
  ['Sean Dwyer', 'worker.deploy', 'incident-triage', 'deployed v1.2.0 (3 replicas, prod)'],
];
export function auditSeed(): AuditEvent[] {
  const r = rng(0xa0d17);
  return AUDIT_TEMPLATES.map((t, i) => ({
    id: `aud-${i}`, tsMins: Math.floor(5 + i * 47 + r() * 30),
    actor: t[0], action: t[1], target: t[2], detail: t[3],
    env: r() > 0.3 ? 'prod' : 'staging', sample: true,
  }));
}

/** Hourly series ending at `now` (ms). Returns [{t, v}] with deterministic shape. */
export function series(now: number, hours: number, base: number, amp: number, seed: number) {
  const r = rng(seed);
  const out: Array<{ t: number; v: number }> = [];
  for (let i = hours - 1; i >= 0; i--) {
    const diurnal = 0.6 + 0.4 * Math.sin(((hours - i) / hours) * Math.PI * 2);
    out.push({ t: now - i * 3600_000, v: Math.max(0, Math.round((base * diurnal + (r() - 0.5) * amp) * 100) / 100) });
  }
  return out;
}

/** Representative fleet run rows for the Runs explorer (overlaid with live runs by the server). */
export interface SampleRun { id: string; worker: string; tenant: string; status: string; steps: number; tokens: number; costUsd: number; ageMins: number; sample: true; }
export function sampleRuns(n: number): SampleRun[] {
  const r = rng(0x12345);
  const statuses = ['ok', 'ok', 'ok', 'ok', 'blocked', 'stopped', 'ok', 'error'];
  const tn = TENANT_NAMES.map((t) => t[0] as string);
  const out: SampleRun[] = [];
  for (let i = 0; i < n; i++) {
    const tokens = 400 + Math.floor(r() * 7000);
    out.push({
      id: `run_${(0x10000 + i * 7).toString(16)}`, worker: pick(r, AGENT_NAMES), tenant: pick(r, tn),
      status: pick(r, statuses), steps: 2 + Math.floor(r() * 9), tokens,
      costUsd: Math.round(tokens * 0.000002 * 100) / 100, ageMins: Math.floor(r() * 1440), sample: true,
    });
  }
  return out;
}
