# syntax=docker/dockerfile:1

# General-purpose OpenCode runtime. Tool versions come from versions.env, which
# is the single source of truth shared with the publish workflow. Plain
# `docker build` accepts the same names as --build-arg; start.sh exports them.

# Global build args must be declared before the first FROM to be usable in
# FROM lines.
ARG BUN_VERSION
ARG RUST_VERSION

FROM oven/bun:${BUN_VERSION} AS bun
FROM rust:${RUST_VERSION}-bookworm AS rust

FROM ubuntu:24.04

ARG TARGETARCH
ARG NODE_VERSION
ARG UV_VERSION
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
        build-essential \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Node.js, pinned to the version in versions.env.
RUN case "${TARGETARCH}" in \
        amd64) node_arch=x64 ;; \
        arm64) node_arch=arm64 ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl --retry 5 --retry-delay 5 --retry-all-errors -fsSL \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
        | tar -xJ --strip-components=1 -C /usr/local

# Bun from the pinned official image.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# uv, pinned to the version in versions.env.
RUN case "${TARGETARCH}" in \
        amd64) uv_arch=x86_64 ;; \
        arm64) uv_arch=aarch64 ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl --retry 5 --retry-delay 5 --retry-all-errors -fsSL \
        "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" \
        | tar -xz -C /tmp \
    && install -m 0755 "/tmp/uv-${uv_arch}-unknown-linux-gnu/uv" /usr/local/bin/uv \
    && install -m 0755 "/tmp/uv-${uv_arch}-unknown-linux-gnu/uvx" /usr/local/bin/uvx \
    && rm -rf "/tmp/uv-${uv_arch}-unknown-linux-gnu"

# Rust toolchain. rustup and the toolchains stay read-only under /usr/local and
# are executable by every user. CARGO_HOME is intentionally not set here: the
# entrypoint points it at a writable per-instance directory so the cargo
# registry/install cache is never shared with the immutable tool install.
ENV RUSTUP_HOME=/usr/local/rustup
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
# Official Rust images make these trees writable for arbitrary users. Keep the
# installed tools immutable here; caches and cargo installs use instance HOME.
RUN chmod -R a+rX,go-w /usr/local/rustup /usr/local/cargo

# OpenCode CLI, pinned to the version in versions.env.
RUN case "${TARGETARCH}" in \
        amd64) opencode_target=linux-x64-baseline ;; \
        arm64) opencode_target=linux-arm64 ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl --retry 5 --retry-delay 5 --retry-all-errors -fsSL \
        "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${opencode_target}.tar.gz" \
        | tar -xz -C /usr/local/bin opencode \
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

# Keep /usr/local/cargo/bin on PATH for the rustup proxies even though
# CARGO_HOME points at the instance directory at runtime.
ENV HOME=/home/bun \
    OPENCODE_UID=1000 \
    OPENCODE_GID=1000 \
    PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /home/bun/workspace

# The entrypoint mirrors a read-only config source (or seeds baked defaults),
# owns the managed HOME directories, drops root to OPENCODE_UID/OPENCODE_GID,
# and execs the requested command verbatim. Extension images such as
# `docker run <image> Rscript script.R` are therefore not intercepted by an
# `opencode` entrypoint.
ENTRYPOINT ["/usr/local/bin/opencode-entrypoint"]
CMD ["opencode"]
