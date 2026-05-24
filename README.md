# airlock-deploy

> **Status:** early development. Design locked in [`CONTEXT.md`](./CONTEXT.md) and [`docs/adr/`](./docs/adr/). v0.x ships: full CLI ([`packages/cli`](./packages/cli/)) with `init` / `doctor` / `status` / `deploy` / `delete` / `logs` / `dev` / `secret` / `domain` / `login` / `logout` / `whoami`, three Payment Middlewares (Workers / Fly-Node / Fly-Python) with **per-token credit-balance support**, the backend + dashboard ([`packages/server`](./packages/server/)) with GitHub OAuth, and an end-to-end Ollama demo ([`examples/local-llm-agent`](./examples/local-llm-agent/)). Our own tunnel server is the remaining v1 piece — for now, `dev` wraps `cloudflared`. `docs/PLAN.md` is the original placeholder and is superseded.

"ngrok for AI agents" — expose any HTTP-speaking Agent in dev via a public Tunnel, deploy it to the Publisher's own cloud in prod. Airlock contracts are one supported Shape; MCP, A2A, and OpenAI tools are first-class too.

## Mission

Take an Airlock-contract-aware agent project from `airlock build` output to **live in production on the publisher's own cloud account**, with the well-known URLs served automatically.

This project is intentionally separate from `airlock` itself. `airlock` is contract format + dev-time tooling; `airlock-deploy` is the bridge from those outputs to a running endpoint.

## Design constraint (inherited from airlock ADR 0001)

**`airlock-deploy` never becomes a hosted runtime.** It scaffolds + configures + invokes the publisher's own platform (Cloudflare Workers first, others later). The publisher owns the cloud account, the secrets, the URL, and the data. `airlock-deploy` never holds traffic for publishers.

If the project ever needs to hold traffic, that is Layer 3 territory and a separate (paid) product — not this repo.

## v1 target candidate

**Cloudflare Workers** — global edge, native `/.well-known/...` serving, built-in secrets (`wrangler secret put`), free tier, single-command deploy.

Likely CLI surface (subject to change):

```
airlock-deploy init my-agent --target=cloudflare
airlock-deploy deploy
airlock-deploy domain add api.example.com
airlock-deploy secret set OPENAI_API_KEY
airlock-deploy logs
```

Each command wraps the underlying platform's CLI (`wrangler` for Cloudflare) with Airlock-aware defaults.

## How this composes with `airlock`

```
airlock (the docs project)        airlock-deploy (this project)
  contract.yaml             ──►   reads for metadata
  airlock build  → static bundle ──► serves at /.well-known/airlock.yaml
  airlock codegen → handler stubs ──► wires into the runtime entry point
```

`airlock-deploy` must not modify the Airlock-produced files; it treats them as immutable inputs.

## Open questions

These will be resolved in their own planning session. Captured here so they aren't lost.

1. **Final name.** Candidates: `airlock-deploy` (current), `hangar`, `berth`, `pier`.
2. **One deploy target or two for v1.** Cloudflare-first is the default. Vercel / Fly / Lambda come later only after the abstraction is proven.
3. **Codegen handoff.** Re-read the Airlock contract directly, or consume `airlock codegen` output? Probably both — read contract for metadata, consume codegen for handler stubs.
4. **Contract version-update flow.** When the publisher releases v2 of their contract, does `airlock-deploy` auto-redeploy, or wait for an explicit trigger?
5. **License.** Apache-2.0 to match airlock (planned).
6. **Repo layout.** Sibling repo (current) vs monorepo with airlock. Sibling chosen for clear license boundaries and independent versioning.

## License

Apache-2.0 (planned; file will be added with the first real release).
