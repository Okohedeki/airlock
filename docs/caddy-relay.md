# Native public agents with Caddy

Airlock runs the agent on your computer. Another computer calls its HTTPS URL
using a caller API key; it needs no Airlock connector or VPN software.
The operator console uses the same public origin and a separate operator token.

Cloudflare publishing, its provisioning commands, and the cloudflared dependency
have been removed. The current connector implementation uses open-source frp;
Caddy provides the HTTPS entry point on an operator-owned relay server.

## Current status

- `airlock up` publishes through `.airlock/relay.json` by default.
- `airlock up --relay <path>` selects another saved profile.
- `airlock up --no-tunnel` explicitly selects local development.
- Startup verifies that the public URL reaches this exact worker launch.
- Failed publication stops the worker. Connector exit ends the service with a
  failure status; frp handles temporary network reconnection internally.
- A native Caddy HTTPS smoke test against the Python worker passed on Windows,
  including caller/operator authorization and exclusion of legacy control routes.
- The frp smoke test is blocked on the development Windows machine because
  Defender quarantined the official, checksum-verified binaries. The proposed
  alternative is OpenSSH behind Caddy; that transport is not implemented yet.
- Automatic relay enrollment, bundled connector installation, and OS service
  installers are not shipped. Public internet validation needs an actual relay
  server, DNS, and certificates. Do not mistake local tests for a live deployment.

## Relay prerequisites

Use one trusted worker per relay configuration. This is not a multi-tenant tunnel
service. The relay operator controls a public server and a DNS hostname such as
`agent.example.com`. Caddy and frps run on that server; frpc runs beside the agent.
Native binaries are available for desktop platforms; Docker and WSL are not
required on the worker computer.

The relay needs inbound TCP 80/443 for public HTTPS and certificate issuance,
and TCP 7000 for the authenticated connector. The worker needs only outbound
connectivity. Keep the forwarded port (18080 by default) bound to relay loopback.

Install Caddy from its [official distribution](https://caddyserver.com/docs/install)
and frp from its [official releases](https://github.com/fatedier/frp/releases).
Verify release checksums before execution. Do not disable endpoint protection
to make an unapproved connector run.

## Worker profile

Save this non-secret routing profile as `.airlock/relay.json`:

```json
{
  "hostname": "agent.example.com",
  "serverAddr": "relay.example.com",
  "serverPort": 7000,
  "remotePort": 18080,
  "caFile": "relay-ca.pem",
  "frpc": "frpc"
}
```

`caFile` is resolved beside the profile. Supply the CA that signed the relay's
connector certificate; its certificate SAN must match `serverAddr`. An explicit
frpc path is also resolved beside the profile. Public HTTPS certificates are
managed separately by Caddy. Certificate verification is never disabled.

Set `AIRLOCK_RELAY_TOKEN` to a randomly generated 64-character hexadecimal secret
on both the worker launcher and frps. Keep it in a private environment file or
service credential store, never in Git. Also set `AIRLOCK_OPERATOR_TOKEN` on the
worker and configure required caller API keys in `worker.yaml`. Public launches
reject permissive authentication profiles.

Once the relay is configured, run from the worker project:

```sh
airlock up --python python
```

The launcher starts frpc without a separate terminal and prints the public URL
only after its HTTPS health check returns the current launch identity.

## Relay configuration

The CLI source exports `renderRelayServer` from `relay-server.ts` for generating
Caddy and frps configuration; an interactive provisioning command is not shipped.
The generated frps configuration requires `relay.crt` and `relay.key` in its
working directory. It reads the shared token from `AIRLOCK_RELAY_TOKEN`, forces
TLS, restricts proxy ports, and binds forwarded traffic to `127.0.0.1`.

The Caddy configuration exposes `/v1/*`, `/console`, `/console/*`, `/healthz`, and
`/metrics`. Application authorization still applies. The Caddy administration API
is disabled. Other routes return 404. Streaming responses flush immediately.

The intended background-service hosts are Windows Services, macOS launchd,
and Linux systemd. At present `airlock up` owns the worker and connector for its
process lifetime; it does not install itself as an OS service.

## Call from another computer

```sh
curl https://agent.example.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CALLER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

For durable work, submit to `/v1/jobs` and poll the returned job URL. Remote
approvals require both the caller key and operator token; see [jobs](jobs.md).
Never send connector credentials to the public worker API.
