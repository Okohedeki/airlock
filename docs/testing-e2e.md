# End-to-end testing — airlock (post–Epic 00)

This is the manual + automated test plan for verifying airlock works **end to end**
in its current state: a payment-free, self-hosted agent behind an OpenAI-compatible
URL, plus the `worker.yaml` migration scaffold from Epic 00.

It has two layers:
1. **Automated gates** — what CI / `pnpm` + `pytest` already prove, no live model needed.
2. **Live E2E scenarios** — the real-hardware, real-model path the unit tests *cannot*
   cover (a model, a tunnel, a browser). Each scenario lists exact commands and a
   pass/fail bar.

> Scope note: the redesign features (loop control, state, fleet router, multi-tenancy,
> triggers, sharding, contract shaping) are **not built yet** — see `docs/redesign/`.
> This plan covers what exists today. A "what each epic adds to E2E" map is at the end.

---

## 0. Prerequisites

| Need | Why | Check |
| --- | --- | --- |
| Node ≥ 22 + pnpm | build/run the CLI | `node -v && pnpm -v` |
| Python ≥ 3.9 | the agent runtime | `python3 --version` |
| A model endpoint | the agent needs an LLM | local gguf **or** a remote `OPENAI_API_BASE` |
| (optional) Cloudflare account | only for `--durable` stable URL | token in `AIRLOCK_CF_TUNNEL_TOKEN` |

A capable model matters: a 1B handles one tool step but flails at multi-step
orchestration. Use a 7B+ (local) or a fast hosted OS-model provider for the
tool-chaining scenarios (E2E-3).

---

## 1. Automated gates (no live model)

These run in seconds and gate every change. All must be green.

```bash
# TS workspace
pnpm install
pnpm -r build          # cli + server compile
pnpm -r typecheck
pnpm -r test           # 70 CLI + 30 server unit tests
pnpm lint

# Python runtime
cd python/agent-runtime
python3 -m venv .venv && . .venv/bin/activate
pip install --upgrade pip && pip install -e '.[dev]'
pytest -q              # 41 tests: surface, concurrency, streaming, discovery
```

**Payment-free invariant** (Epic 00 gate) — must return only test guards + the
README redesign banner, no payment *logic*:

```bash
grep -rinE "payment|wallet|x402|usdc|airlock_payment|airlock-crypto|PaymentMiddleware" \
  packages python examples README.md --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.venv
```

**Pass:** all suites green; grep shows only `*.test.ts` absence-assertions and the
README banner.

---

## 2. Live E2E scenarios

Run from a scratch project dir. Pick a harness (smolagents is the simplest local path).

### E2E-1 — Wire a harness with `init --detect`

```bash
mkdir /tmp/airlock-e2e && cd /tmp/airlock-e2e
# (drop in a minimal agent, e.g. copy examples/smolagent-local/agent.py + requirements.txt)
airlock init e2e-agent --self-host --detect
airlock doctor
```

**Pass:** `.airlock/config.toml` has an `[agent]` block with the detected `harness` +
`entrypoint` and **no `[payment]` block**; `airlock doctor` reports all ✓ (config
read, schemaVersion 1, target valid, agent wired) and prints the discovery-bundle
line. **Fail:** any ✗, or a `[payment]` section appears.

### E2E-2 — Install runtime + go live

```bash
pip install -r requirements.txt
pip install ./.airlock/vendor/agent-runtime          # note: NO payment-fly anymore
export OPENAI_API_BASE=…  OPENAI_API_KEY=…           # or a local gguf via the harness env
airlock up
```

**Pass:** prints `✓ live at https://<name>.trycloudflare.com` and
`callers POST to: <url>/v1/chat/completions`. Health is up:
`curl -s localhost:3000/healthz` → `{"ok":true}`. **Fail:** the old "did not become
healthy within 120s" timeout (means runtime didn't import — check the venv has
`airlock_agent` and no stale `airlock_payment` import).

### E2E-3 — Real agent loop (the core behavior)

```bash
curl -s $URL/v1/chat/completions -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"multiply 23 by 19, then what % of 5000 is that?"}]}'
```

**Pass:** a standard `chat.completion` whose final number is **arithmetically
derived from a tool output** (the loop actually chained `multiply` → `percentage`),
and the agent logs show multiple steps. Response carries `usage.total_tokens` and an
`X-Airlock-Units` header (token accounting survived; it is **not** payment).
**Fail:** a canned answer with no tool steps in the logs, or a missing/`0` usage.

### E2E-4 — Streaming (SSE)

```bash
curl -N $URL/v1/chat/completions -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":true}'
```

**Pass:** `content-type: text/event-stream`; first frame `delta:{"role":"assistant"}`,
content frames, a `usage` frame, then `[DONE]`. (Heartbeat keeps TTFB ~0 even while
the native loop runs.) **Fail:** a single buffered JSON body, or an idle-timeout drop.

### E2E-5 — Concurrency admission (429 + Retry-After)

```bash
AIRLOCK_MAX_CONCURRENCY=1 AIRLOCK_MAX_QUEUE=1 airlock up   # in one terminal
# in another: fire ~5 concurrent requests
for i in $(seq 5); do curl -s -o /dev/null -w "%{http_code}\n" $URL/v1/chat/completions \
  -d '{"messages":[{"role":"user","content":"x"}]}' & done; wait
```

**Pass:** ~2 `200`s (1 running + 1 queued), the rest `429` with a `Retry-After`
header. `curl -s $URL/metrics` shows live `running`/`waiting`/`pending`. **Fail:**
all hang, or all 200 (cap not enforced).

### E2E-6 — Discovery bundle (`/.well-known`)

With an `airlock-config` bundle present under `dist/.well-known/`:

```bash
curl -s $URL/.well-known/airlock-config.yaml
curl -s $URL/ | python3 -m json.tool      # info route
```

**Pass:** the bundle is served verbatim; `/` reports
`"discovery": "/.well-known/airlock-config.yaml"` and `"shape": "openai"` and has
**no `"payment"` key**. Without a bundle: `/.well-known/...` → 404 and
`"discovery": null`, agent still answers. **Fail:** a `payment` key appears, or
discovery 500s.

### E2E-7 — Durable tunnel (optional, needs Cloudflare)

```bash
export AIRLOCK_CF_TUNNEL_TOKEN=…           # your connector token
# set [tunnel].hostname in .airlock/config.toml
airlock up --durable
```

**Pass:** `✓ live (durable) at https://<your-hostname>`; the URL resolves to your
agent and survives a connector restart (supervision reconnects with backoff).
**Fail:** `airlock doctor` should have caught a missing token/hostname *before* this.

### E2E-8 — `worker.yaml` migration (Epic 00 deliverable)

```bash
airlock migrate
cat worker.yaml
```

**Pass:** `worker.yaml` maps `worker.name`, `harness`, `entrypoint`, and
`expose` (= `public` iff `[tunnel].durable`, else `internal`), carries the tunnel
hostname when present, lists the `# TODO(epic 07)` blocks, and contains **no payment
field**. **Fail:** a payment field is carried, or required fields are dropped.

### E2E-9 — Dashboard (login / sync / inspect)

```bash
# with the server running (packages/server)
airlock login --backend <url>
airlock sync
# open the dashboard, view the project
```

**Pass:** login stores a token (`~/.airlock/auth.json`), `sync` registers the
project, the dashboard renders the project with a **Calls / Unique callers / Tokens**
stat grid and **no Revenue/Settled/USDC** UI.

> ⚠️ **Known gap (post–Epic 00):** the live call **reporter** lived in the payment
> middleware, so the dashboard currently records **no new calls** — it renders
> existing rows only. Re-homing reporting is **Epic 05 (observability)**. So E2E-9
> verifies the UI is payment-free and existing data renders; it does **not** assert
> new calls appear.

---

## 3. One-shot smoke script (CI-friendly)

A minimal non-interactive smoke that needs only a reachable `OPENAI_API_BASE`:

```bash
set -euo pipefail
URL=...                       # from `airlock up` output, or a fixed --no-tunnel port
test "$(curl -s $URL/healthz)" = '{"ok":true}'
curl -s $URL/ | grep -q '"shape": "openai"'
curl -s $URL/ | grep -qv '"payment"'                      # payment key must be absent
code=$(curl -s -o /dev/null -w '%{http_code}' $URL/v1/chat/completions \
  -d '{"messages":[{"role":"user","content":"say OK"}]}')
test "$code" = "200"
echo "smoke OK"
```

Run `airlock up --no-tunnel` for a deterministic `localhost:3000` target in CI
(skips the Cloudflare dependency).

---

## 4. What each redesign epic will add to this E2E plan

As the redesign lands, extend this doc per epic:

| Epic | New E2E assertion |
| --- | --- |
| 01 Loop engine | `StepEvent`s emitted per step across **all** harnesses (not just LangGraph/Claude) |
| 02 Guards | budget/`max_steps` breach → partial result + reason; approval gate holds a run |
| 03 Routing | per-step model swap; backup model takes over on injected failure |
| 04 State | checkpoint → resume from last step; fork from step N; tool-result cache hit |
| 05 Observability | **dashboard records new calls again**; live step stream; per-step $/latency |
| 06 Sandbox | a tool exceeding its rlimit fails the step (not the host) |
| 07 Manifest | boot from `worker.yaml` (not `config.toml`); hot-reload a piece in dev |
| 08 Versioning | canary split; one-command rollback flips traffic |
| 09 Deploy | `docker run airlockhq/airlock`; `expose: internal↔public` flip |
| 10 Tenancy | API-key/JWT/mTLS auth; per-tenant isolation + usage |
| 11 Triggers | cron fires a run; signed webhook invokes a run |
| 12 Sharding | one endpoint routes to the variant by capability/cost/latency |
| 13 Contract | bad input rejected pre-loop; output repaired once + redacted |

---

## 5. Pass/fail summary

The build is **end-to-end healthy today** when: §1 gates are green, **E2E-1→E2E-6
and E2E-8** pass with a capable model, and the §3 smoke is green. E2E-7 (durable)
and E2E-9 (dashboard) are environment-dependent and may be skipped, but E2E-9 must
at least confirm the **payment-free UI**. The dashboard "new calls" assertion is
deferred to Epic 05.
