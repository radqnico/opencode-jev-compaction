# syntax: docker/dockerfile:1
ARG NODE_VERSION=22-bookworm-slim
FROM node:${NODE_VERSION} AS base
ENV DEBIAN_FRONTEND=noninteractive

# OpenCode binary is downloaded at build time so the image pins a version.
ARG OPENCODE_VERSION=latest
# First-time-install simulation: nothing from the host leaks in except the
# plugin source (mounted read-only at runtime, not baked in).

FROM base AS opencode-fetch
ARG OPENCODE_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar && rm -rf /var/lib/apt/lists/*
RUN if [ "${OPENCODE_VERSION}" = "latest" ]; then \
      OPENCODE_VERSION=$(curl -fsSL https://api.github.com/repos/anomalyco/opencode/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p'); \
      echo "resolved latest opencode: ${OPENCODE_VERSION}"; \
    fi && \
    echo "${OPENCODE_VERSION}" > /tmp/opencode-version.txt && \
    mkdir -p /tmp/ocdl && cd /tmp/ocdl && \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" -o opencode.tar.gz && \
    tar xzf opencode.tar.gz && \
    ls -la && \
    mkdir -p /opt/opencode && cp opencode* /opt/opencode/ 2>/dev/null || cp -r ./* /opt/opencode/ ; \
    ls -la /opt/opencode/

FROM base AS test
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl jq && rm -rf /var/lib/apt/lists/*
COPY --from=opencode-fetch /opt/opencode /opt/opencode
COPY --from=opencode-fetch /tmp/opencode-version.txt /tmp/opencode-version.txt
ENV PATH="/opt/opencode:${PATH}"
# Isolated HOME so the container behaves like a first-time install:
# fresh ~/.config/opencode, fresh plugin cache, no host credentials.
ENV HOME=/home/tester
RUN useradd -m -s /bin/bash tester && mkdir -p /workspace/plugin /home/tester/.config/opencode && chown -R tester:tester /home/tester /workspace
WORKDIR /workspace/plugin
# Install plugin deps first for a stable layer; source is mounted at runtime.
COPY --chown=tester:tester package.json package-lock.json* ./
USER tester
RUN npm install --no-audit --no-fund 2>&1 | tail -n 3
# Default command runs the full harness (overridable for interactive use).
COPY --chown=tester:tester docker/entrypoint.sh /usr/local/bin/harness.sh
ENTRYPOINT ["/usr/local/bin/harness.sh"]
