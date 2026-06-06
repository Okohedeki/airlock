# airlockhq/airlock — the single Worker runtime image (epic 09, ADR-0012).
#
# Bakes the Python agent runtime; the model stays external (ADR-0019). A worker
# boots entirely from a mounted worker.yaml (epic 07). The fleet router + cloudflared
# front this image for `expose: public`.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=3000

WORKDIR /app

# Install the runtime. Tools that need the harness frameworks add them to a derived
# image; the base ships the engine + stub/openai bindings (no heavy deps).
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir .

# The worker.yaml + any tool modules are mounted/added at run time:
#   docker run -p 3000:3000 -v "$PWD:/work" -w /work airlockhq/airlock
# The runtime reads ./worker.yaml from the working directory.
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+__import__('os').environ.get('PORT','3000')+'/healthz').status==200 else 1)" || exit 1

ENTRYPOINT ["python", "-m", "airlock_agent"]
