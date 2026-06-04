# Epic 00 — Foundations: strip crypto + reset airlock-config + `worker.yaml` migration

## Context
The redesign needs a clean base. Today airlock-deploy bundles a full crypto/payment stack
(x402 + USDC + wallets) and treats `airlock-config` as a runtime driver. The brief removes
monetization entirely and narrows `airlock-config` to a **buyer-facing descriptor**, with all
operational composition moving to a new `worker.yaml`. This epic is prerequisite-but-subordinate:
it clears payment out of every load-bearing path and scaffolds the manifest migration so the
control-the-loop epics build on solid ground.

## Scope
- Remove **all** crypto/payment from airlock-deploy.
- Reset `airlock-config` to descriptor-only (kept as an npm dep for validation + `/.well-known`
  serving; supplies skill schemas to epic 13).
- Scaffold the `.airlock/config.toml → worker.yaml` migration (full schema defined in epic 07).

**Non-goals:** the typed `/skills/<id>` endpoints + contract integration (moved to epics 07/13);
the loop engine (epic 01).

## Dependencies
None. Prerequisite for everything else.

## Design

### Delete entirely
- `packages/payment-core/`, `packages/payment-workers/`, `packages/payment-fly-node/`
- `python/payment-fly/` (incl. its committed `.venv`)
- `python/agent-runtime/src/airlock_agent/tools/` (only `buy.py` + `__init__.py`)
- `python/agent-runtime/tests/test_buy_tool.py`
- `docs/payment.md`
- `packages/cli/src/commands/serve.ts` + `serve.test.ts` (the command was defined as x402
  enforcement; users wrap bare models via `airlock dev` + the runtime surface)

### Edit — TS CLI (replace load-bearing paths)
- `packages/cli/src/config-file.ts` — drop `PaymentConfigSchema` import, the `payment?` field,
  and `validatePayment()`. (Epic 07 supersedes this file with the `worker.yaml` loader.)
- `packages/cli/src/commands/up.ts` — delete the payment env block
  (`PAYMENT_ENABLED`/`PUBLISHER_WALLET`/`PAYMENT_NETWORK`/`PRICE_USDC`), `noPayment`, the
  `payment: ON/OFF` log. Keep concurrency + tunnel logic (epic 09 reworks spawn → Docker).
- `packages/cli/src/commands/doctor.ts` — remove the payment findings block; fix the latent
  target check (errors unless `target==='workers'`) to validate membership.
- `packages/cli/src/commands/status.ts` — remove the `payment` summary block.
- `packages/cli/src/commands/init.ts` — remove `PAYMENT_SCAFFOLD`, the `payment-fly` vendor line
  + `VENDOR_PACKAGES` entry, narrow the requirements regex to `^airlock-agent\b`.
- `packages/cli/src/cli.ts` — remove the `serve` command + import; rewrite `init` "next steps"
  text (drop `payment.wallet`).
- `packages/cli/package.json` — drop `@airlockhq/payment-core`, `@airlockhq/payment-fly-node`,
  and `serve`-only deps (`express`/`@types/express`/`supertest` — verify via grep).

### Edit — Python runtime
- `serve.py` — delete `config_from_env()`; drop `payment_config` from `create_app`.
- `surface.py` — remove `airlock_payment` imports, `PaymentMiddleware` mount, `payment_config`/
  `payment_kwargs` params, the `payment` info-route key; replace `USAGE_UNITS_HEADER` with a
  literal `X-Usage-Units` (keep token `usage` accounting — not payment).
- `__main__.py` / `__init__.py` — drop `config_from_env` import/usage/exports; update docstrings.
- `pyproject.toml` — remove `airlock-payment` dep + the `crypto`/`airlock-crypto` extra.
- `tests/test_surface.py` — remove payment assertions; adjust `create_app(...)` calls.

### Edit — dashboard/server
- `packages/server/src/db.ts` — stop writing/reading `amount_usdc`/`payment_settled`; remove
  revenue/paid aggregation in `projectStats` + `usdcToAtomic`/`atomicToUsdc`. **Leave the columns
  in place** (no SQLite migration); they go dead.
- `packages/server/src/pages.ts` — remove Revenue + Paid-calls cards/columns + payment copy.
- `packages/server/tests/server.test.ts` — drop revenue/payment assertions.

### airlock-config reset
- Keep `airlock-config` as a pinned npm dep (`airlock-config@0.5.0`) used for: validating the
  descriptor (`validateContractFile`), building the `/.well-known` bundle (`buildFromFile`), and
  supplying skill JSON Schemas (consumed by epic 13). It is **not** a runtime driver.

### `worker.yaml` migration scaffold
- Add a `airlock migrate` command stub + a converter `config.toml → worker.yaml` (full schema in
  epic 07). For this epic, only the project/agent/tunnel fields need mapping; payment fields are
  dropped.

## Key files
Deletions + edits enumerated above. New: `packages/cli/src/migrate.ts` (stub).

## Open questions
- Confirm `express`/`supertest` have no non-`serve` importers before removal.
- Dashboard DB: leave-dead-columns (chosen) vs a one-time reset — confirm at implementation.

## Verification
- `grep -rin "payment\|wallet\|x402\|usdc\|airlock_payment\|airlock-crypto\|PUBLISHER_WALLET\|withPaymentExpress\|PaymentMiddleware" packages python docs README.md CONTEXT.md examples` → zero hits in source (superseded ADR history excepted).
- `pnpm install && pnpm -r build && pnpm -r test && pnpm typecheck && pnpm lint` green.
- Python: recreate the agent-runtime venv, `pip install -e .[dev]`, `pytest` green
  (`test_buy_tool` removed; `test_surface` payment-free).
- Supersede ADR-0005/0006; the runtime still boots and serves a `/.well-known` bundle if present.
