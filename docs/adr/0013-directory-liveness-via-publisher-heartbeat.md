# Directory liveness via publisher heartbeat, not a poller

The airlock-directory exists to answer a question a static list cannot: **which
registered agents are actually live?** The `agents` table carries a `status`
(live/degraded/offline/unknown) and `status_checked_at`, but today nothing ever
updates them — status is written once at registration (defaulting to `unknown`)
and then stays permanently stale. No cron, scheduled function, or health-poller
exists anywhere in the repo. Until that changes, the Supabase-backed registry is
no better than a static file for its one differentiating feature.

**Decision: the publisher's running agent heartbeats the directory; the directory
never calls out.**

`airlock up` pings a directory heartbeat endpoint on a timer. Each heartbeat
stamps `status_checked_at`; **freshness is computed at read time** ("live if last
seen < N minutes ago, else offline") so there is no cron and no scheduled
function to operate. Because a heartbeat is a write to a public endpoint, it must
be authenticated against spoofing — a publisher should not be able to keep a dead
competitor looking live, nor mark a rival offline. The directory issues a
**per-agent token at registration** that `airlock up` replays on each heartbeat;
the token scopes writes to that one agent's row.

We accept an explicit semantic limit: a heartbeat proves the **agent process is
running**, not that its public URL is reachable (the process can be up while its
tunnel is down). The field is therefore surfaced as **"last seen,"** not
"guaranteed reachable." That is honest and sufficient for v1. A reachability
poller — the directory probing each agent's public `/healthz` — is the strictly
stronger signal and is deferred to v1.1 as an upgrade, not a replacement.

## Considered Options

- **Scheduled poller (Supabase cron Edge Function)** — pings each agent's
  `/healthz` and writes status. This is the *strongest* signal (proves public
  reachability, not just process liveness) and the truest value prop. *Deferred,
  not chosen for v1*: it needs a cron function, careful handling of up-but-slow
  agents, and it turns the directory into an outbound caller of arbitrary
  publisher URLs (an SSRF/abuse surface to harden). Revisit in v1.1.
- **Honest labeling only** — relabel the field "self-reported at registration,
  may be stale" and ship no liveness mechanism. Tightest scope, zero infra, but
  the directory stays a static list for this release. Rejected: heartbeat is
  cheap enough that real freshness is worth it for v1.
- **No token, trust the source host (TOFU only)** — reuse the registration host
  check for heartbeats. Rejected: TOFU guards *first* registration, but a bare
  unauthenticated heartbeat write is still spoofable; a per-agent token is the
  minimal real defense.
