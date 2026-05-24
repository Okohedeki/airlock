# Dev is free, prod is paid

The natural funnel for `airlock` is dev → prod: solo devs and OSS authors build agents on the dev tunnel; when they ship to customers, they graduate to the production path. We chose this as the primary paid wedge instead of an ngrok-style "free tier with restricted tunnel, paid tier with better tunnel" model. The Free signed-in tier is **deliberately generous** — stable subdomain, no time caps, 3 concurrent tunnels, full agent-aware observability, all Shape detectors, ~50 GB/mo bandwidth cap. The paid Pro tier unlocks `airlock deploy` to the publisher's own cloud, custom domains, longer log retention, and multi-agent management. An Anonymous tier (rotating URL, ~30 min auto-close, 1 tunnel) exists only for the marketing-page 5-second wow; every real user signs up.

## Considered Options

- **ngrok-style tunnel tiering** — pay for stable URLs, better inspect, etc. Rejected: our differentiator is *agent-aware* deploy, not tunnel quality. Paywalling tunnel features kneecaps the dev tier that funnels the paid tier.
- **Pure usage-based pricing** — no tiers, pay per request/GB. Rejected: punishes the "I'm building and iterating" loop and creates billing anxiety during dev.
- **Open core with no hosted product** — pure OSS, no monetization layer. Rejected: leaves no funded path to operate the hosted tunnel infrastructure that makes the on-ramp magical.
