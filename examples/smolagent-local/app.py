"""Deployable service: the smolagents CodeAgent behind an OpenAI-compatible API.

    pip install -r requirements.txt
    OPENAI_API_BASE=http://localhost:8080/v1 python app.py
    # then: POST /v1/chat/completions  {"messages":[{"role":"user","content":"multiply 23 by 19"}]}

Payment is OFF by default (free); set PAYMENT_ENABLED=1 + PUBLISHER_WALLET to bill.
"""

from adapter import SmolagentsAdapter
from airlock_agent import serve

if __name__ == "__main__":
    serve(SmolagentsAdapter(), name="smolagent-local")
