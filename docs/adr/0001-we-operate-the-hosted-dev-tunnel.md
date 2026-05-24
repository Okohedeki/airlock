# We operate the hosted dev tunnel

`airlock` has two surfaces: a dev tunnel and a prod deploy. Production preserves the "publisher owns their cloud" invariant — `airlock deploy` never holds production traffic. But dev needs a public URL for a locally-running Agent on the first run, with no friction. We chose to operate the hosted dev tunnel infrastructure ourselves so that `airlock dev` produces a public URL in seconds, with no third-party account required. This explicitly narrows the original "never holds traffic" invariant to **"never holds *production* traffic"** — we do hold dev traffic, scoped to ephemeral tunnels, rate-limited, and never used for prod. The tunnel server itself is open source so anyone can self-host their own tunnel; the hosted version is a convenience layer, not a moat.

## Considered Options

- **Cloudflare Tunnel on the publisher's account** — preserves "never holds traffic" globally, but requires the publisher to set up a Cloudflare account before their first tunnel works. Kills the 5-second wow.
- **Wrap ngrok itself** — ngrok's useful features are paywalled; we'd be reselling someone else's product with no value-add beyond agent shape detection.
- **Pluggable backend (Cloudflare Tunnel / ngrok / frp)** — premature abstraction; we don't yet have evidence the right backend varies by publisher.
