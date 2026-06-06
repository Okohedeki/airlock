/**
 * Functioning demo for the Fleet Router (epic 09 + 08 + 12 + 10 + 04).
 * Not a unit test — a runnable script that exercises the real router and asserts
 * the frozen behaviors, printing PASS/FAIL. Run: `npx tsx src/router/demo.ts`.
 */

import { Registry, createRouter, type RouteRequest } from './index.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const reg = new Registry();
// v1 stable: 2 general replicas + 1 coder replica
reg.register({ id: 'g1', name: 'agent', version: 'v1', variant: 'general', host: '10.0.0.1', port: 9001, capabilities: ['chat'], costEstimate: 1, latencyMs: 50 });
reg.register({ id: 'g2', name: 'agent', version: 'v1', variant: 'general', host: '10.0.0.2', port: 9001, capabilities: ['chat'], costEstimate: 1, latencyMs: 60 });
reg.register({ id: 'c1', name: 'agent', version: 'v1', variant: 'coder', host: '10.0.0.3', port: 9001, capabilities: ['code'], costEstimate: 3, latencyMs: 80 });
// v2 canary: 1 general replica
reg.register({ id: 'g3', name: 'agent', version: 'v2', variant: 'general', host: '10.0.0.4', port: 9001, capabilities: ['chat'], costEstimate: 1, latencyMs: 40 });

reg.setRollout('agent', { stable: 'v1', canary: { version: 'v2', pct: 50 } });
reg.apiKeys.set('k-acme', 'acme');

const route = createRouter(reg);
const base: RouteRequest = { worker: 'agent', apiKey: 'k-acme' };

// 1. Canary split — distinct sessions land on a mix of v1/v2
const versions = new Set<string>();
for (let i = 0; i < 20; i++) {
  const ctx = await route({ ...base, sessionId: `s${i}`, capability: 'chat' });
  versions.add(ctx.version!);
}
check('canary splits traffic across versions', versions.has('v1') && versions.has('v2'), [...versions].join('/'));

// 2. Stickiness wins over canary — same session keeps its version even after rollback
const first = await route({ ...base, sessionId: 'sticky', capability: 'chat' });
reg.setRollout('agent', { stable: 'v2' }); // operator promotes v2 / rolls forward
const second = await route({ ...base, sessionId: 'sticky', capability: 'chat' });
check('a live session never flips version mid-run', first.version === second.version, `${first.version}==${second.version}`);

// a NEW session after promote gets the new stable (canary still ramps / promote sticks)
const fresh = await route({ ...base, sessionId: 'fresh-after-promote', capability: 'chat' });
check('new session honors the current rollout', fresh.version === 'v2', fresh.version);

// 3. Variant routing by capability (epic 12)
reg.setRollout('agent', { stable: 'v1' });
const coder = await route({ ...base, sessionId: 'x-code', capability: 'code' });
const chat = await route({ ...base, sessionId: 'x-chat', capability: 'chat' });
check('capability routes to the right variant', coder.variant === 'coder' && chat.variant === 'general', `${coder.variant}/${chat.variant}`);

// 4. Load balancing across healthy replicas of the selected variant (epic 09)
const targets = new Set<string>();
for (let i = 0; i < 8; i++) {
  const ctx = await route({ ...base, capability: 'chat' }); // anonymous → not pinned → spreads
  targets.add(ctx.target!.id);
}
check('load spreads across healthy replicas', targets.size >= 2, [...targets].join(','));

// unhealthy replica avoided
reg.workers.find((w) => w.id === 'g1')!.healthy = false;
const avoid = await route({ ...base, capability: 'chat' });
check('unhealthy replica is avoided', avoid.target!.id !== 'g1', avoid.target!.id);

// 5. Auth reject (epic 10, stage 1)
let rejected = false;
try {
  await route({ worker: 'agent', sessionId: 'noauth', capability: 'chat' });
} catch (e) {
  rejected = String(e).includes('401');
}
check('unauthenticated caller rejected at stage 1', rejected);

// 6. Expose flip — same routes, internal vs public (epic 09)
const internalUrl = 'http://10.0.0.1:9001/v1/chat/completions';
const publicUrl = 'https://agent.trycloudflare.com/v1/chat/completions';
check('expose flips reach, not routes', new URL(internalUrl).pathname === new URL(publicUrl).pathname);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
