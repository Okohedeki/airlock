FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=3000
EXPOSE 3000
# Model is Claude via the Anthropic API — set ANTHROPIC_API_KEY (airlock secret set …).
# airlock never hosts inference (ADR-0008).
CMD ["python", "-m", "airlock_agent"]
