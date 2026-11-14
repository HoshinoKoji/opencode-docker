ARG RUNTIME_IMAGE=ghcr.io/hoshinokoji/opencode-runtime:local
ARG RUST_VERSION=1.99.0
FROM rust:${RUST_VERSION}-bookworm AS rust
# Prepare permissions before copying to avoid duplicating the toolchain layer.
RUN chmod -R a+rX,go-w /usr/local/rustup /usr/local/cargo
FROM ${RUNTIME_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH
# The inherited entrypoint sets a writable per-user CARGO_HOME.
