# Desktop gateway, v1

The desktop runs both the agent and its public HTTPS gateway. Caddy forwards
requests to the worker on loopback; no external relay, frp connector, Docker,
or WSL is needed for this path. Other computers call the HTTPS API normally.

## First launch

1. Install the Python runtime and your agent framework's dependencies.
2. Run `airlock up` in your agent project or workspace.
3. Choose **Host a gateway**. Save a domain or subdomain you control.
4. Choose **Prepare this desktop** if gateway software is not installed.
5. Choose **Check connection** and complete the DNS/router steps it reports.
6. Select your agent and press **Start**.

Airlock downloads a pinned official Caddy release, verifies its SHA-512 checksum,
and keeps the binary in your private Airlock directory. The saved address and
generated settings stay outside your agent repository. No relay file or token
entry is required. Caddy starts and stops with the agent.

After setup, `airlock up --headless` runs directly from an agent project using
the saved desktop address and automatically managed credentials.

## Home network requirements

The domain's DNS record must point to your home public IP. Your router must
forward TCP ports 80 and 443 to the desktop, and the firewall must allow Caddy.
Airlock shows the desktop's address selected by the operating system's route.
Networks using a VPN may need router-specific guidance.

**Check connection** checks DNS resolution and local port availability. It does
not prove that your router forwards traffic or that your internet provider
allows incoming connections. **Start** waits for the domain's trusted HTTPS
health endpoint to identify the exact worker instance just launched. It never
disables certificate verification or substitutes a local URL on failure.

Some routers do not support reaching your public IP from inside the home network
(NAT loopback). That can prevent the startup check even if external access works.
If the provider uses CGNAT, request a public IP or use a separately hosted gateway.
Airlock does not change router settings or firewall rules automatically.

Caddy manages certificates using its normal automatic HTTPS behavior. On systems
that restrict binding ports below 1024, the gateway needs the corresponding OS
permission. Keep the desktop awake while the agent should be available.

## Access and scope

Worker calls and administration remain authenticated. Airlock generates and
remembers separate caller and operator credentials; **Manage agent** signs in
automatically. The public gateway exposes worker routes only. The local launcher
and Caddy administration API are not published.

V1 hosts one active agent on the gateway desktop. Pairing separate agent computers
to this gateway, multiple simultaneous agents, automatic DNS/router provisioning,
dynamic IP updates, and OS background-service installation are not implemented.
The older explicit `--relay` path remains available separately; see
[Caddy relay setup](caddy-relay.md) for its connector requirements and limitations.

Verified on the development Windows desktop: native Caddy installation, generated
configuration validation, launcher setup and validation flows, local agent
Start/Stop, and automated security/lifecycle tests. Public internet validation
still requires a real configured domain and reachable home connection.
