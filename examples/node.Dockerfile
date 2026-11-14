ARG RUNTIME_IMAGE=ghcr.io/hoshinokoji/opencode-runtime:local
ARG NODE_VERSION=24.15.0
FROM node:${NODE_VERSION}-bookworm-slim AS node
FROM ${RUNTIME_IMAGE}
COPY --from=node /usr/local/ /usr/local/
