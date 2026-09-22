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

Approval holds remain recorded across restarts. This first API slice does not
provide job resume, cancel, or retry endpoints, nor a job-aware console. Existing
run decision/replay APIs are separate; they do not update the original job's
outcome. Safe continuation tied to exact approved arguments is a following step.
