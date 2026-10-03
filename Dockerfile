ARG UV_VERSION=latest
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv-binaries

FROM oven/bun:debian

# Docker's predefined HTTP(S)_PROXY / ALL_PROXY / NO_PROXY build args are
# available to apt and bun when passed by the build command (see compose.yaml).
COPY --from=uv-binaries /uv /uvx /usr/local/bin/

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/bun/workspace /home/bun/.config/opencode /home/bun/.local/share/opencode /home/bun/.bun/bin \
    && chown -R bun:bun /home/bun/workspace /home/bun/.config /home/bun/.local /home/bun/.bun

ENV HOME=/home/bun \
    BUN_INSTALL=/home/bun/.bun \
    BUN_INSTALL_BIN=/home/bun/.bun/bin \
    PATH="/home/bun/.bun/bin:/home/bun/.local/bin:${PATH}"

USER bun
ARG OPENCODE_VERSION=latest
RUN bun install -g "opencode-ai@${OPENCODE_VERSION}" \
    && opencode --version \
    && uv --version

WORKDIR /home/bun/workspace
COPY --chown=bun:bun AGENTS.md MEMORY.md ./
COPY --chown=bun:bun config/opencode/ /home/bun/.config/opencode/

ENTRYPOINT ["opencode"]
