FROM python:3.12-slim

ARG SPEEDTEST_VERSION=1.2.0

# iputils-ping: ICMP for lightweight uptime checks
# curl/ca-certificates: needed to fetch the Ookla static binary
RUN apt-get update && \
    apt-get install -y --no-install-recommends iputils-ping curl ca-certificates && \
    arch="$(dpkg --print-architecture)" && \
    case "$arch" in \
      amd64)  ookla_arch="x86_64" ;; \
      arm64)  ookla_arch="aarch64" ;; \
      armhf)  ookla_arch="armhf" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac && \
    curl -fLo /tmp/speedtest.tgz \
      "https://install.speedtest.net/app/cli/ookla-speedtest-${SPEEDTEST_VERSION}-linux-${ookla_arch}.tgz" && \
    tar -xzf /tmp/speedtest.tgz -C /usr/local/bin speedtest && \
    chmod +x /usr/local/bin/speedtest && \
    rm -f /tmp/speedtest.tgz && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app.py .
COPY frontend /frontend

# Data is stored here; mount this as a volume to persist across restarts
RUN mkdir -p /data
VOLUME ["/data"]

ENV NETPULSE_DB=/data/netpulse.db
ENV SPEEDTEST_INTERVAL_MIN=30
ENV PING_INTERVAL_SEC=60
ENV PING_HOST=1.1.1.1

EXPOSE 8077

CMD ["python", "app.py"]
