# Durable background jobs

Use jobs for work that should continue after its submitting HTTP connection closes.
The worker records the input and outcome in its local SQLite store. This API does
not require Cloudflare or a tunnel.

## Configuration

```yaml
state:
  backend: sqlite
  dsn: .airlock/state.db
```

Run one worker process per database on a local filesystem. Startup takes an OS
lock beside the database; another worker using that database fails startup. Do
not delete the `.jobs.lock` file while a worker is running. Network shares and
multiple database aliases/hard links are unsupported. Memory storage leaves the
existing chat API available but returns `503` for jobs. `GET /` reports
`durable_jobs: true` when the job executor is available.

## Submit and inspect

`POST /v1/jobs` accepts only a `messages` list. It uses the same caller
authentication and session header as chat. With API-key authentication configured:

```http
POST /v1/jobs
Authorization: Bearer <caller-key>
Content-Type: application/json

{"messages":[{"role":"user","content":"Prepare a release summary"}]}
```

The response is `202 Accepted`, with a generated `job_id`, matching `run_id`,
`status: "accepted"`, and `url: "/v1/jobs/<job_id>"`. The `Location` header contains
that URL. Save the job ID and poll the URL with the same caller credentials.
The worker persists the record before acknowledging acceptance. Execution runs
in a worker thread independently of the request.

Admission uses the same concurrency gate as chat. Submission can wait for a slot
up to the configured queue timeout and returns `429` when admission fails. There
is no durable waiting queue yet: a `202` means the execution slot was acquired.
There is no submission idempotency key yet. Repeating a POST creates another job;
if its response is lost, do not blindly repeat consequential work.

`GET /v1/jobs/<job_id>` returns the authenticated tenant's record, including input,
timestamps, status, and the final content/token count when available. Other tenants
receive `404`; an operator token alone does not grant caller access. Configure
caller authentication before exposing the API beyond a trusted local environment.

## Outcomes and recovery

Records transition from `running` to `completed`, `awaiting_approval`, `blocked`,
`stopped`, or `failed`. The corresponding engine execution record uses the same
run ID. Job responses are not cached. Inputs and results remain in the database;
automatic retention and deletion are not implemented yet.

On restart, records still marked `running` become `interrupted`. They are never
automatically re-executed. An external action may already have succeeded before
the worker stopped or failed to persist its outcome. Inspect the execution record
and reconcile effects before retrying. Job state alone cannot provide exactly-once
external effects.

Graceful shutdown waits for running job threads; forcefully stopping the process
leaves their records for interruption recovery. A hanging tool can delay graceful
shutdown, so tool deadlines remain necessary.

## Continue a reviewed approval

A job in `awaiting_approval` includes an `approval` object with `approval_id`,
`tool`, `args`, and an optional `deadline`. These survive a worker restart.

1. Inspect that exact proposal. Record a decision with
   `POST /v1/runs/<job_id>/decision`, providing
   `{"decision":"approve","approval_id":"<review-id>"}`. Other choices are
   `deny`, `skip`, `override` (with `result`), and `edit` (with an `args` object).
   An empty edit object is valid. Job decisions require the displayed review ID;
   stale, expired, or already-decided approvals are rejected.
2. Call `POST /v1/jobs/<job_id>/continue` with
   `{"approval_id":"<review-id>"}`. Both calls require the tenant's caller key
   and `X-Airlock-Operator-Token`. Continuation returns `202` and uses the same
   job URL; poll it for the new outcome.

Each continuation atomically claims the job and receives a new `run_id`.
`previous_run_ids` preserves the earlier attempts for inspection. The decision
route always uses the stable **job ID**, including for a later approval hold.
Consumed decisions retain their original arguments, verdict, and timestamps.

The owned loop reuses recorded model outputs and completed tool results before
the held action. It checks every proposed action against that trace, rejects
changed arguments or action ordering, and consumes the specific approval once
before dispatch. Edited calls retain both the original and applied arguments.
Current deny rules and accumulated budgets still apply at the approval boundary.
Token totals include the recorded prefix; replay does not call those models again.

Keep trusted worker code and configuration stable across continuation: this is
action/argument validation, not a cryptographic identity check of tool code.
Wrapped loops, incomplete or failed traces, and interrupted jobs cannot use this
continuation path. A crash after approval consumption still requires manual
reconciliation; uncertain effects are never automatically retried.

Legacy chat, resume, and fork endpoints cannot reuse job run IDs. Non-job runs
retain their legacy APIs and do not gain the durable continuation guarantees.
The existing console sends review IDs when recording decisions; a consolidated
job console, cancellation, and submission/retry idempotency remain future work.
