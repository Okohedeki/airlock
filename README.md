# airlock-deploy

> **Status:** placeholder. Not yet started. The first design pass lives in [`docs/PLAN.md`](./docs/PLAN.md). Code arrives soon.

The deployment companion to [airlock](https://github.com/Okohedeki/airlock).

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
