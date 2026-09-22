# Airlock: controlled work on your machine

Airlock runs a worker, asks before consequential actions, and records enough
state to explain and recover its work. Airlock owns the execution loop; framework
tool extraction does not promise to preserve arbitrary framework orchestration.

## The supported product boundary

One worker, one manifest, one runtime, one operator console. The core journey is:

1. Run a worker locally.
2. Submit a job and inspect progress.
3. Review the exact action awaiting approval; approve, edit, or deny it.
4. Recover interrupted work with an explicit account of completed side effects.
5. Inspect the execution record and output.

Background jobs and local approval notifications support this journey. Fleet
orchestration, canaries, organization management, SSO, marketplaces, and advanced
model routing are outside the first redesign milestone. Existing fleet and
registry dashboards are legacy surfaces, not the redesigned administration path.

## Security and networking contract

- Local operation is the default. Starting a worker must not create a tunnel.
- Public access is an explicit deployment choice, independent of execution.
- Caller credentials authorize work; operator credentials authorize controls
  and approval decisions. Caller credentials must never imply operator access.
- Missing operator configuration disables administration; it never grants it.
- The operator console and administration routes belong on a private interface.
  A public reverse proxy must allow only the intended caller routes.
- Neither a tunnel nor a private network substitutes for application authorization.

The intended Windows distribution is a service with a bundled runtime and a local
console. Direct public hosting uses a domain and a Windows-native HTTPS proxy
such as Caddy. It requires an inbound-reachable network; behind carrier-grade NAT,
an ISP-provided public address or an optional relay is still necessary. Cloudflare
is an optional integration, not part of the runtime contract.

## Reliability contract

Persist job identity and transitions independently of HTTP connections. Capture
approval decisions against the exact action and arguments. On restart, surface
interrupted or uncertain work rather than silently repeating external actions.
Exactly-once external effects require tool-specific idempotency or reconciliation;
a local checkpoint alone cannot guarantee them.

Sandboxing must fail closed when its required isolation is unavailable. Native
Windows execution is not yet an isolation boundary for untrusted tools. Release
identities must include the actual source and pinned runtime, not just metadata.

## Delivery order

1. Establish private defaults and separate operator authorization, including a
   usable console authentication flow and regression coverage.
2. Implement durable job lifecycle, approval recovery, and side-effect handling.
3. Consolidate the console around jobs, approvals, history, and worker settings.
4. Package and verify a native Windows service and optional direct HTTPS hosting.

These are acceptance criteria for the redesign, not claims that all are shipped.
The release scenario is a worker preparing an action, waiting for approval,
surviving a restart, accepting a correction, and completing with an auditable
record and explicit duplicate-action protection.
