FROM python:3.13-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl procps dos2unix && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agente_ao_vivo_v4.py .
COPY kb_api.py .
COPY kb_admin.html .
COPY supabase_rag.py .
COPY start.sh .
RUN dos2unix start.sh && chmod +x start.sh

RUN mkdir -p /app/media

ENV PYTHONUNBUFFERED=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["./start.sh"]
