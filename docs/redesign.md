# Airlock: publish and manage a worker from your machine

Airlock starts a native service on Windows, macOS, or Linux, provides a public HTTPS URL, and lets
authorized callers invoke and manage the worker remotely. Jobs, approvals, and
recovery support that main experience. Ollama is one possible model behind the
worker, not the product boundary. Airlock owns the execution loop; framework
tool extraction does not promise to preserve arbitrary framework orchestration.

## The supported product boundary

One worker, one manifest, one runtime, one operator console. The core journey is:

1. Start the native service and receive its public HTTPS URL.
2. Call the worker externally and inspect its connection and job status remotely.
3. Review the exact action awaiting approval remotely; approve, edit, or deny it.
4. Recover interrupted work with an explicit account of completed side effects.
5. Inspect the execution record and output.

Background jobs and approval notifications support this journey. Fleet
orchestration, canaries, organization management, SSO, marketplaces, and advanced
model routing are outside the first redesign milestone. Existing fleet and
registry dashboards are legacy surfaces, not the redesigned administration path.

## Security and networking contract

- Public access is the primary service journey. First setup configures publication;
  later service starts restore that connection and report the public URL.
- The worker can bind to loopback behind the connector. This internal binding
  must not be confused with a local-only product or a completed public connection.
- Keep a local-only development mode. Report publication failures clearly rather
  than claiming the worker is externally reachable merely because it is healthy.
- Caller credentials authorize work; operator credentials authorize controls
  and approval decisions. Caller credentials must never imply operator access.
- Missing operator configuration disables administration; it never grants it.
- Authenticated remote management is part of the product. The public entry point
  must distinguish caller routes from protected management routes; exposing the
  worker must not expose unrestricted administration.
- Neither a tunnel nor a private network substitutes for application authorization.

The intended desktop distribution bundles the runtime and a native frp connector,
with service startup, reconnection, credentials, and URL discovery managed by
Airlock. Normal use must not require WSL, Docker, or a separate tunnel terminal.
A native client still needs a publicly reachable endpoint: an outbound relay
provides the automatic-URL path behind NAT; direct HTTPS requires reachable
ingress and a domain. The selected relay uses Caddy for public HTTPS and frp for
the outbound worker connection. The operator controls the relay server and domain;
Airlock manages connector configuration and lifecycle. The initial deployment is
one trusted worker per relay configuration, not a multi-tenant tunnel platform.
Windows Services, macOS launchd, and Linux systemd are the intended service hosts.
Cloudflare
remains an optional adapter, not a required account or runtime dependency.

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
3. Deliver the native Windows service-to-public-URL path, including connector
   supervision, stable URL recovery, caller authentication, and external checks.
4. Consolidate remote management around connection status, jobs, approvals,
   history, and worker settings.

These are acceptance criteria for the redesign, not claims that all are shipped.
The release scenario starts by calling the Windows worker through its public URL,
then follows it preparing an action, waiting for remote approval,
surviving a restart, accepting a correction, and completing with an auditable
record and explicit duplicate-action protection.
