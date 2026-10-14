#!/bin/sh
# Check the runtime's pinned tools with actionable version mismatch messages.
set -eu

: "${OPENCODE_VERSION:?load versions.env}"
: "${NODE_VERSION:?load versions.env}"
: "${BUN_VERSION:?load versions.env}"
: "${UV_VERSION:?load versions.env}"
: "${RUST_VERSION:?load versions.env}"

check_exact() {
    if [ "$2" != "$3" ]; then
        printf '%s version mismatch: expected [%s], got [%s]\n' "$1" "$3" "$2" >&2
        exit 1
    fi
    printf '%s version OK: %s\n' "$1" "$2"
}

check_with_metadata() {
    case "$2" in
        "$3"|"$3 "*) printf '%s version OK: %s\n' "$1" "$2" ;;
        *)
            printf '%s version mismatch: expected [%s] with optional metadata, got [%s]\n' "$1" "$3" "$2" >&2
            exit 1
            ;;
    esac
}

# V1 prints the bare version; V2 prints "opencode v<version>". Normalize
# only this known prefix, keeping the pinned numeric version check strict.
opencode_version=$(opencode --version)
printf 'OpenCode --version: %s\n' "$opencode_version"
check_exact OpenCode "${opencode_version#opencode v}" "$OPENCODE_VERSION"
node_version=$(node --version)
check_exact Node "$node_version" "v$NODE_VERSION"
bun_version=$(bun --version)
check_exact Bun "$bun_version" "$BUN_VERSION"
uv_version=$(uv --version)
check_with_metadata uv "$uv_version" "uv $UV_VERSION"
cargo_version=$(cargo --version)
check_with_metadata Cargo "$cargo_version" "cargo $RUST_VERSION"
rust_version=$(rustc --version)
check_with_metadata Rust "$rust_version" "rustc $RUST_VERSION"
