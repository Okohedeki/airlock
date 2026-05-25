/**
 * Starter files for a harness-backed agentic service on the Fly Recipe, emitted
 * by `airlock init --agent=<harness>`. Thin by design: the deploy scaffolding +
 * a runnable stub adapter. The full reference adapter for each harness lives in
 * `examples/<harness>-agent/`. Fly-only (these Harnesses are Python; ADR-0003).
 */

import type { TemplateFile } from './fly-node.js';

export type AgentHarness = 'smolagents' | 'langgraph' | 'crewai';

export const AGENT_HARNESSES: readonly AgentHarness[] = ['smolagents', 'langgraph', 'crewai'];

const HARNESS_DEPS: Record<AgentHarness, string> = {
  smolagents: 'smolagents==1.25.*',
  langgraph: 'langgraph>=0.2,<1\nlangchain-openai>=0.2,<1',
  crewai: 'crewai>=0.80,<1',
};

export function flyAgentStarter(name: string, harness: AgentHarness): TemplateFile[] {
  return [
    {
      path: 'requirements.txt',
      content: `${HARNESS_DEPS[harness]}
airlock-agent
airlock-payment
fastapi>=0.115,<1
uvicorn[standard]>=0.30,<1
pyyaml>=6,<7
`,
    },
    {
      path: 'Dockerfile',
      content: `FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=3000
EXPOSE 3000
# Model is a publisher-supplied endpoint — set OPENAI_API_BASE / OPENAI_API_KEY (ADR-0008).
CMD ["python", "app.py"]
`,
    },
    {
      path: 'app.py',
      content: `"""Deployable ${harness} agent behind an OpenAI-compatible API.

    pip install -r requirements.txt
    OPENAI_API_BASE=http://localhost:8080/v1 python app.py
"""

from adapter import Adapter
from airlock_agent import serve

if __name__ == "__main__":
    serve(Adapter(), name="${name}")
`,
    },
    {
      path: 'adapter.py',
      content: `"""Your HarnessAdapter — runs your ${harness} harness's FULL native loop and
returns its final answer. Replace the body of run(). For a complete, working
reference, see examples/${harness}-agent/adapter.py in the airlock repo.
"""

from airlock_agent import AgentRunResult, messages_to_task


class Adapter:
    def run(self, messages):
        task = messages_to_task(messages)
        # TODO: build + run your ${harness} harness on \`task\`, sum its token
        # usage across the run, and return the final answer.
        return AgentRunResult(content=f"(stub) received: {task}", units=0)
`,
    },
  ];
}
