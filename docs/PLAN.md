# airlock-deploy — initial plan

This is the design carry-over from the `airlock` repo's grilling session. When this project actually starts, do a real grill-with-docs pass to convert these notes into concrete decisions + ADRs.

## Why this is a separate repo

The `airlock` project is contract format + open-source dev-time tooling. Adding deployment to it would:

1. Pull `airlock` toward platform thinking (the §0 invariant in `airlock/prompt.md` is "not a wire protocol, not a network stack" — deployment lives close to that line).
2. Couple `airlock`'s release cadence to the deploy target's release cadence (a Cloudflare API change shouldn't gate a contract schema change).
3. Mix license boundaries if we ever take per-target sponsorships.

So: sibling repo, sibling lifecycle. Composable via the static bundle + codegen output.

## What `airlock-deploy v1` ships

A single prescriptive recipe for **Cloudflare Workers**, exposed as a CLI:

```
airlock-deploy init <name> --target=cloudflare
  ─► scaffolds a Worker project including:
     ├── contract.yaml         (stub authored from a template)
     ├── src/index.ts          (Worker entry — codegen'd handler stubs)
     ├── wrangler.toml         (Cloudflare config, well-known routing included)
     ├── package.json
     └── README.md             (how to deploy)

airlock-deploy deploy
  ─► runs `airlock build` first (produces dist-pages/ from contract.yaml)
  ─► uploads dist-pages/ as static assets via wrangler
  ─► runs `wrangler deploy` for the runtime code
  ─► prints the live URL

airlock-deploy domain add <hostname>
  ─► wraps `wrangler` custom-domain setup

airlock-deploy secret set <KEY>
  ─► delegates to `wrangler secret put` (we never see the value)

airlock-deploy logs
  ─► wraps `wrangler tail`
```

Anything not on this list is out of scope for v1.

## What v1 explicitly does not do

- Host runtimes for publishers (`airlock-deploy` itself owns zero infrastructure)
- Manage publisher secrets (Cloudflare handles them via `wrangler secret put`)
- Support multiple targets (one prescriptive recipe; multi-target abstraction comes only after two real targets exist)
- Generate codegen output (that's `airlock`'s job)
- Validate or render the contract (that's `airlock`'s job)
- Multi-tenant anything

## Open questions (to grill before writing code)

1. **Should `airlock-deploy` re-validate the contract before deploying, or trust that the publisher already ran `airlock validate`?** Probably re-validate, but with a `--no-validate` escape hatch.
2. **How does `airlock-deploy` reconcile contract version updates with deployed state?** Auto-deploy on contract change, vs. require an explicit `deploy` step.
3. **Where does codegen happen — `airlock codegen` ahead of time, or `airlock-deploy` invokes it at build time?** Probably the latter for ergonomic DX, but it makes the dependency on `airlock` stronger.
4. **Should `airlock-deploy` ship a GitHub Actions workflow template for CI/CD?** Likely yes — it's a natural extension of v1.
5. **License.** Apache-2.0 to match `airlock`.
6. **Versioning.** SemVer; track `airlock` major versions explicitly (e.g., `airlock-deploy 0.x` works with `airlock 0.x`).

## Dependencies on `airlock`

- `airlock` schema (read contract.yaml metadata)
- `airlock build` output (static bundle)
- `airlock codegen` output (handler stubs)
- Status code semantics (so handler return types match what the contract claims)

Declare `airlock` as a peer dep; pin minor versions explicitly.

## Next steps when this project is picked up

1. Open a `grill-with-docs` session on this plan.
2. Pin final name (or keep `airlock-deploy`).
3. Write ADRs for: the "never holds traffic" invariant, the single-target choice, the codegen handoff.
4. Implement the Cloudflare recipe end-to-end against an `airlock` example contract.
5. Dogfood: deploy `Okohedeki/airlock`'s procurement example via this project; confirm it loads on the public URL.
