# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom

# General-purpose OpenCode runtime. Tool versions come from versions.env, which
# is the single source of truth shared with the publish workflow. Plain
# `docker build` accepts the same names as --build-arg; start.sh exports them.
# FROM versions deliberately require build args rather than duplicated defaults.
# Skip only the check that assumes a build without args must be valid; Compose
# requires the versions and a missing tag still fails actual image resolution.

# Global build args must be declared before the first FROM to be usable in
# FROM lines.
ARG BUN_VERSION
ARG UV_VERSION

FROM oven/bun:${BUN_VERSION} AS bun
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM ubuntu:24.04

ARG OPENCODE_VERSION

ENV DEBIAN_FRONTEND=noninteractive

# Generic development tools only. Project-specific toolchains (for example R,
# databases) belong in extension images layered on top of this one.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        xz-utils \
        git \
        fish \
        ripgrep \
        less \
        nano \
        vim \
        openssh-client \
        procps \
        util-linux \
        tar \
        unzip \
        zip \
        gnupg \
        sudo \
        iputils-ping \
        net-tools \
        telnet \
    && rm -rf /var/lib/apt/lists/*

# Bun from the pinned official image.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# uv and uvx from the pinned official image.
COPY --from=uv /uv /uvx /usr/local/bin/

# Bake only the default pin. The launcher installs on first use into the
# persistent data volume, after the entrypoint drops to the runtime UID.
ENV OPENCODE_DEFAULT_VERSION=${OPENCODE_VERSION}
COPY docker/opencode.sh /usr/local/bin/opencode
RUN case "$OPENCODE_VERSION" in ''|*[!0-9.]*) exit 1 ;; esac \
    && printf '%s\n' "$OPENCODE_VERSION" | grep -Eq '^2\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' \
    && chmod 755 /usr/local/bin/opencode

# Neutral development defaults, baked outside any HOME so they survive a
# different mount layout. The entrypoint copies them into the active HOME only
# when no user configuration is mounted.
COPY config/opencode/ /usr/local/share/opencode/config/
COPY docker/entrypoint.sh /usr/local/bin/opencode-entrypoint
RUN chmod 755 /usr/local/bin/opencode-entrypoint

# Conventional non-root developer user at UID/GID 1000. The Ubuntu base image
# already ships an `ubuntu` user at that UID/GID, so it is replaced.
RUN userdel -r ubuntu 2>/dev/null || true \
    && groupdel ubuntu 2>/dev/null || true \
    && groupadd --gid 1000 bun \
    && useradd --create-home --uid 1000 --gid bun --shell /bin/bash bun \
    && mkdir -p \
        /home/bun/workspace \
        /home/bun/.config/opencode \
        /home/bun/.local/share/opencode \
        /home/bun/.cache \
        /home/bun/.cargo \
        /home/bun/.bun \
    && chown -R bun:bun /home/bun

ENV HOME=/home/bun \
    OPENCODE_UID=1000 \
    OPENCODE_GID=1000 \
    PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /home/bun/workspace

# The entrypoint mirrors a read-only config source (or seeds baked defaults),
# owns the managed HOME directories, drops root to OPENCODE_UID/OPENCODE_GID,
# and execs the requested command verbatim. Extension images such as
# `docker run <image> Rscript script.R` are therefore not intercepted by an
# `opencode` entrypoint.
ENTRYPOINT ["/usr/local/bin/opencode-entrypoint"]
CMD ["opencode"]
