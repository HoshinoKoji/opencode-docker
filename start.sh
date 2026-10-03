#!/bin/sh
set -eu

workspace=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$workspace/projects"

normalize_version() {
    version=${2#v}
    case "$version" in
        ''|*[!0-9A-Za-z.-]*)
            printf 'Invalid %s version: %s\n' "$1" "$2" >&2
            return 1
            ;;
        [0-9]*.[0-9]*.[0-9]*)
            printf '%s\n' "$version"
            ;;
        *)
            printf 'Invalid %s version: %s\n' "$1" "$2" >&2
            return 1
            ;;
    esac
}

select_version() {
    tool=$1
    repository=$2
    requested=$3

    # Explicit versions skip the release lookup, including in unattended builds.
    if [ -n "$requested" ] && [ "$requested" != latest ]; then
        normalize_version "$tool" "$requested"
        return
    fi

    if ! command -v curl >/dev/null 2>&1; then
        printf 'curl is required to look up the latest %s version. Install curl, or set UV_VERSION and OPENCODE_VERSION explicitly.\n' "$tool" >&2
        return 1
    fi

    printf 'Looking up the latest %s version...\n' "$tool" >&2
    if ! release_url=$(curl --fail --silent --show-error --head --location \
        --connect-timeout 10 --max-time 30 --retry 2 \
        --output /dev/null --write-out '%{url_effective}' \
        "https://github.com/$repository/releases/latest"); then
        printf 'Could not look up the latest %s version. Check your network connection, or set the corresponding version environment variable and retry.\n' "$tool" >&2
        return 1
    fi

    case "$release_url" in
        "https://github.com/$repository/releases/tag/"*) ;;
        *)
            printf 'Could not parse the %s version from the release URL: %s\n' "$tool" "$release_url" >&2
            return 1
            ;;
    esac
    latest_version=$(normalize_version "$tool" "${release_url##*/}") || return 1
    selected_version=$latest_version

    if [ -t 0 ]; then
        printf '%s version (press Enter for latest %s, or enter a specific version): ' "$tool" "$latest_version" >&2
        input=
        IFS= read -r input || true
        case "$input" in
            ''|latest) ;;
            *) selected_version=$(normalize_version "$tool" "$input") || return 1 ;;
        esac
    fi

    printf '%s\n' "$selected_version"
}

build=false
for argument in "$@"; do
    case "$argument" in
        --build|--build=true) build=true ;;
        --build=false|--no-build) build=false ;;
    esac
done

if [ "$build" = true ]; then
    UV_VERSION=$(select_version uv astral-sh/uv "${UV_VERSION:-}")
    OPENCODE_VERSION=$(select_version OpenCode anomalyco/opencode "${OPENCODE_VERSION:-}")
    export UV_VERSION OPENCODE_VERSION
    printf 'Build versions: uv %s, OpenCode %s\n' "$UV_VERSION" "$OPENCODE_VERSION"
fi

# Let Git resolve the host's global configuration, including XDG paths.
GIT_AUTHOR_NAME=$(git config --global --get user.name || true)
GIT_AUTHOR_EMAIL=$(git config --global --get user.email || true)
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL
GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME
GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
export GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

# Let Compose discover compose.yaml and the optional compose.override.yaml.
exec docker compose --project-directory "$workspace" up -d "$@"
