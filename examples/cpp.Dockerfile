ARG RUNTIME_IMAGE=ghcr.io/hoshinokoji/opencode-runtime:local
FROM ${RUNTIME_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*
