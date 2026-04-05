FROM --platform=linux/amd64 nousresearch/hermes-agent:latest

ARG MCP_SEARXNG_VERSION=1.0.2

ENV YAMS_DAEMON_SOCKET=/tmp/yams-daemon.sock

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dirmngr \
    git \
    gpg \
    libolm-dev \
    procps \
    tini \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://repo.yamsmemory.ai/gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/yams.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/yams.gpg] https://repo.yamsmemory.ai/aptrepo stable main" \
    > /etc/apt/sources.list.d/yams.list \
  && rm -rf /var/lib/apt/lists/* \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    yams \
  && npm install -g "mcp-searxng@${MCP_SEARXNG_VERSION}" \
  && pip install --no-cache-dir "matrix-nio[e2e]" --break-system-packages \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

COPY hermes/config.yaml /opt/hermes-local/config.yaml
COPY hermes/entrypoint.sh /usr/local/bin/hermes-local-entrypoint

RUN chmod +x /usr/local/bin/hermes-local-entrypoint

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/hermes-local-entrypoint"]
CMD ["gateway", "run"]
