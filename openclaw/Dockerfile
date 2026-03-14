FROM debian:sid-slim

ARG NODE_VERSION=22.14.0
ARG OPENCLAW_VERSION=2026.3.12

ENV DEBIAN_FRONTEND=noninteractive
ENV OPENCLAW_CONFIG=/home/node/.openclaw/openclaw.json
ENV NODE_OPTIONS=--max-old-space-size=1536
ENV HOME=/home/node
ENV PATH=/usr/local/bin:/home/node/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

COPY openclaw/entrypoint.sh /usr/local/bin/openclaw-entrypoint

RUN rm -rf /var/lib/apt/lists/* && apt-get clean

RUN echo "Acquire::http::Pipeline-Depth 0; \
    Acquire::http::No-Cache true; \
    Acquire::BrokenProxy true;" > /etc/apt/apt.conf.d/99fixbadproxy

RUN apt-get -o Acquire::Retries=5 update \
  && apt-get install -y \
    ca-certificates \
    curl \
    dirmngr \
    git \
    gpg \
    tini \
    mold \
    clang \
    xz-utils \
    libssl-dev \
    pkg-config \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://repo.yamsmemory.ai/gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/yams.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/yams.gpg] https://repo.yamsmemory.ai/aptrepo stable main" \
    > /etc/apt/sources.list.d/yams.list \
  && rm -rf /var/lib/apt/lists/* \
  && apt-get -o Acquire::Retries=5 update \
  && apt-get install -y \
    yams \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" \
    -o /tmp/node.tar.xz \
  && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
  && rm -f /tmp/node.tar.xz \
  && node --version \
  && npm --version \
  && npm install -g "openclaw@${OPENCLAW_VERSION}" \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1000 node \
  && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash node \
  && mkdir -p /home/node/.openclaw /home/node/.npm /home/node/.cache /app \
  && chown -R node:node /home/node /app \
  && chmod +x /usr/local/bin/openclaw-entrypoint

WORKDIR /app

EXPOSE 18789

ENTRYPOINT ["/usr/local/bin/openclaw-entrypoint"]
CMD ["openclaw", "gateway", "--allow-unconfigured"]
