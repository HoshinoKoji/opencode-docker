#!/bin/sh
set -eu

workspace=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$workspace/projects"

# Pinned tool versions. versions.env only assigns defaults, so explicit
# environment overrides survive. The same file drives local and CI builds.
if [ -f "$workspace/versions.env" ]; then
    set -a
    . "$workspace/versions.env"
    set +a
fi
# Guarantee the pins are visible to Compose's build-arg interpolation even if a
# shell does not export parameter-expansion assignments.
export BUN_VERSION NODE_VERSION UV_VERSION OPENCODE_VERSION RUST_VERSION

build=false
for argument in "$@"; do
    case "$argument" in
        --build|--build=true) build=true ;;
        --build=false|--no-build) build=false ;;
    esac
done

# Run as the host user so mounted files keep the expected ownership. The image
# entrypoint drops from root to these ids and owns only container state.
OPENCODE_UID=$(id -u)
OPENCODE_GID=$(id -g)
export OPENCODE_UID OPENCODE_GID

# Git commit identity inside the container.
GIT_AUTHOR_NAME=$(git config --global --get user.name || true)
GIT_AUTHOR_EMAIL=$(git config --global --get user.email || true)
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL
GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME
GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
export GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

# All instances can share the host's global preferences. The chat profile is a
# separate native configuration overlay declared by compose.yaml.
if [ -z "${OPENCODE_CONFIG_SOURCE:-}" ]; then
    if [ -d "$HOME/.config/opencode" ]; then
        OPENCODE_CONFIG_SOURCE="$HOME/.config/opencode"
    else
        OPENCODE_CONFIG_SOURCE=config/opencode
    fi
fi
# Relative values are resolved against this repository.
case "$OPENCODE_CONFIG_SOURCE" in
    /*) ;;
    *) OPENCODE_CONFIG_SOURCE="$workspace/$OPENCODE_CONFIG_SOURCE" ;;
esac
export OPENCODE_CONFIG_SOURCE

# build args interpolate from versions.env; the running container inherits the
# standard proxy variables from the host environment unchanged.
if [ "$build" = true ]; then
    OPENCODE_IMAGE=${OPENCODE_IMAGE:-ghcr.io/hoshinokoji/opencode-runtime:local}
    export OPENCODE_IMAGE
    if [ -f "$workspace/compose.override.yaml" ]; then
        exec docker compose --project-directory "$workspace" \
            -f "$workspace/compose.yaml" \
            -f "$workspace/compose.build.yaml" \
            -f "$workspace/compose.override.yaml" \
            up -d "$@"
    fi
    exec docker compose --project-directory "$workspace" \
        -f "$workspace/compose.yaml" \
        -f "$workspace/compose.build.yaml" \
        up -d "$@"
fi

# No explicit files: Compose discovers compose.yaml and compose.override.yaml.
exec docker compose --project-directory "$workspace" up -d "$@"
