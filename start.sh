#!/bin/sh
set -eu

workspace=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Let Git resolve the host's global configuration, including XDG paths.
GIT_AUTHOR_NAME=$(git config --global --get user.name || true)
GIT_AUTHOR_EMAIL=$(git config --global --get user.email || true)
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL
GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME
GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
export GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

exec docker compose --project-directory "$workspace" -f "$workspace/compose.yaml" up -d "$@"
