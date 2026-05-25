# airlock never hosts inference

A deployed Agent's model is always a **Publisher-supplied OpenAI-compatible endpoint** (`OPENAI_API_BASE` / `OPENAI_API_KEY`), never inference that airlock operates. The Publisher picks where the model runs — self-host (vLLM/llama.cpp on their own GPU), a bring-your-own-key fast OS-model provider (Groq/Together/Fireworks), or a white-glove setup we automate **on the Publisher's own cloud account**. In every case the account, key, cost, and ops stay with the Publisher; airlock only wires `OPENAI_API_BASE`/`OPENAI_API_KEY` as secrets. This preserves the open-source-neutral posture and the ADR-0001 "never hold prod traffic" invariant — the moment we ran models, inference cost, scaling, abuse handling, and key custody would fall on us.

Inference speed (which matters more for agentic loops, since latency compounds across steps) is therefore the Publisher's lever via their provider choice — fast OS-model providers run the same open weights faster than most self-hosts — not something we solve by hosting.

## Considered Options

- **airlock hosts/curates inference (rejected for the open-source core).** Best UX for non-technical publishers, but makes us an inference platform: GPU ops, scaling, abuse, key custody, and a proprietary surface. This is explicitly a future, separate, *paid* Layer-3 product — not the open core, not v1.
- **Publisher-supplied OpenAI-compatible endpoint (accepted).** Configurable base URL covers self-host and any provider, works for any OS model, keeps inference off our books.
