FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=3000
EXPOSE 3000
# Model is a publisher-supplied endpoint — set OPENAI_API_BASE / OPENAI_API_KEY
# (airlock secret set …). Never bake inference into this image (ADR-0008).
CMD ["python", "app.py"]
