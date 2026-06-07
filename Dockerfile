# syntax=docker/dockerfile:1
#
# airlock worker runtime — self-contained, build context = repo root.
#
# Builds the Python agent-runtime and bakes the `live-demo` stub worker as the
# default so `docker run` works with no config. Mount your own worker dir at
# /app/worker (worker.yaml + code) to override the bundled demo.
#
#   docker build -t airlock-worker .
#   docker run -p 3000:3000 airlock-worker                       # bundled live-demo
#   docker run -p 3000:3000 -v "$PWD/my-worker:/app/worker" airlock-worker
#
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=3000 \
    AIRLOCK_LOG_LEVEL=INFO

# Install the runtime package (pure-Python deps; no toolchain needed).
WORKDIR /app/runtime
COPY python/agent-runtime/pyproject.toml python/agent-runtime/README.md ./
COPY python/agent-runtime/src ./src
RUN pip install --no-cache-dir .

# Bundle the deterministic stub live-demo as the default worker. A volume mounted
# at /app/worker overrides it. The runtime reads ./worker.yaml from this cwd.
WORKDIR /app/worker
COPY examples/live-demo/ ./

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','3000')+'/healthz').status==200 else 1)" || exit 1

ENTRYPOINT ["python", "-m", "airlock_agent"]
