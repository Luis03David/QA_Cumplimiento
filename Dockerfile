FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates nodejs npm \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY package.json package-lock.json ./
RUN npm ci

COPY config ./config
COPY docs ./docs
COPY scripts ./scripts
COPY tests ./tests
COPY plan.md ./

RUN chmod +x scripts/run_dependency_audit.py scripts/run_secret_scan.py scripts/run_phase0.sh scripts/run_phase1.sh

CMD ["bash", "scripts/run_phase0.sh"]
