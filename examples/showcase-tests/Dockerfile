# syntax=docker/dockerfile:1
# Containerized showcase test runner — pytest + httpx against the harness services.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN pip install --no-cache-dir pytest httpx

WORKDIR /tests
COPY examples/showcase-tests/test_showcase.py ./

# -ra prints a one-line summary per test → a readable PASS/FAIL grid; non-zero exit on failure.
CMD ["pytest", "-v", "-ra", "--no-header", "--tb=short"]
