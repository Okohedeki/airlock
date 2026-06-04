# Running a Worker in Docker (the reproducible path)

> **Docker is the decided direction** (`ADR-0012`, accepted). The "no Docker for v1" you
> may see is **archived/superseded** — it lives only in `MEMORY.md`'s pre-redesign history.
> Host `python3` is the dev convenience; **Docker is how you ship reproducibly.**

Different machines have different Python versions, tool dependencies, and harness
frameworks. `airlock build` pins all of that into one image so a Worker runs identically
everywhere — and the image digest *is* the version artifact (epic 08).

## The flow

```bash
cd examples/live-demo
airlock build                 # validate worker.yaml → build airlock/<name>:<contenthash>
airlock up --docker           # run the image: publish port + state volume + public tunnel
# dev shortcut (no rebuild on each edit):
airlock up --docker --mount   # mounts the project into the base image
```

- **`airlock build`** validates `worker.yaml` through the one schema (the CLI is the gate,
  ADR-0020), generates a `Dockerfile` `FROM airlockhq/airlock` that COPYs your project and
  `pip install -r requirements.txt`, and tags by a **content hash** of
  `worker.yaml` + `requirements.txt` → same manifest, same image (idempotent rebuild).
- **`airlock up --docker`** runs that image and opens the public Cloudflare URL the same way
  the host path does (the tunnel stays host-side — no creds in the image). `--image <ref>`
  runs a specific image; `--env-file` passes secrets.

## The control plane is unchanged

Containerizing changes *packaging*, not *control*. All 13 features stay driven by the same
surface — `worker.yaml` + the HTTP API + `/console` (reachable at
`http://localhost:<port>/console`):

| Feature | In a container |
|---|---|
| 01 loop · 05 observability · 13 io | pure Python, served on the published port — unchanged |
| 02 guards/approval · 10 tenancy · 11 triggers | unchanged; approvals/webhooks over the port |
| 06 sandbox | **stronger** — real rlimit/network isolation on Linux |
| 07 manifest | `worker.yaml` is the baked, content-addressed image (a worker, not an output) |
| 04 state/cache | unchanged — **persisted to a mounted volume** |

## Three plumbing accommodations (not control changes)

1. **State volume** — the SQLite State Store at `.airlock/state.db` is mounted
   (`-v $PWD/.airlock:/app/worker/.airlock`) so runs/sessions/cache/held-runs persist across
   `docker stop` / restart.
2. **Host-run models → `host.docker.internal`** — a model on the host (e.g. `llama-server`)
   is reachable from the container at `http://host.docker.internal:<port>`, not `127.0.0.1`.
   `airlock up --docker` adds `--add-host=host.docker.internal:host-gateway`; `airlock doctor`
   warns if a `models.*.endpoint` uses `127.0.0.1`/`localhost`. (Remote APIs work as-is —
   inference stays external, ADR-0019.)
3. **Secrets via env** — API keys and `HOOK_SECRET` pass through with `--env-file` or are
   forwarded from the host (`OPENAI_API_KEY`, `HOOK_SECRET`, `AIRLOCK_*`).

## Adding frameworks / tool deps

Put them in a `requirements.txt` next to `worker.yaml` (the examples already do this):

```
# examples/langgraph-agent/requirements.txt
langgraph>=0.2,<1
langchain-openai>=0.2,<1
```

`airlock build` installs them on top of the lean base. The base image
(`airlockhq/airlock`) ships only the engine + stub/openai bindings; frameworks come from
your per-project layer, so the base stays small and your image is fully pinned.

## What's not here yet (fleet)

Multi-container deploy — the registry, the fleet router as a live service, canary across
images (epics 08/12 + multi-container 09) — is a separate effort. This page is the
single-worker reproducible run. The router logic + demo already exist in
`packages/cli/src/router`.
