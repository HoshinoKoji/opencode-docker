#!/bin/sh
set -eu

usage() {
    cat <<'EOF'
Usage: ./start.sh [OPTIONS] [-- COMPOSE_UP_ARGUMENTS...]

Start the container workspace. Flags override environment/.env settings;
repeated flags are applied in order (last wins).

  -h, --help                Show this help without starting anything
  --build                  Build from source before starting (default: off)
  --no-build               Disable source building
  --proxy URL              Set both HTTP and HTTPS proxies
  --http-proxy URL         Set OPENCODE_HTTP_PROXY
  --https-proxy URL        Set OPENCODE_HTTPS_PROXY
  --no-proxy HOSTS         Set NO_PROXY (comma-separated bypass list)
  --disable-proxy          Clear all build/container proxy variables
  --port PORT              Set OPENCODE_PORT (default: 14096)
  --bind ADDRESS           Set OPENCODE_BIND_ADDRESS (default: 0.0.0.0)
  --image IMAGE            Set OPENCODE_IMAGE (default: runtime:0.2.4;
                           source builds use runtime:local)
  --config-source DIR      Set OPENCODE_CONFIG_SOURCE (default: host
                           ~/.config/opencode if present, else config/opencode)
  --skills-source DIR      Set OPENCODE_SKILLS_SOURCE (default: config/skills)

Value flags accept --flag VALUE or --flag=VALUE. Proxy values may be empty.
Relative source paths are resolved against this repository.
Use -- before Docker Compose up options or service names.

Environment settings:
  HTTP/HTTPS proxies: OPENCODE_HTTP_PROXY / OPENCODE_HTTPS_PROXY, then
  HTTP_PROXY / HTTPS_PROXY, then http_proxy / https_proxy.
  ALL_PROXY and NO_PROXY fall back to their lowercase forms.
  Proxy flags affect build commands and containers; Docker/BuildKit image
  pulls use Docker/BuildKit's own proxy settings.
  OPENCODE_SERVER_PASSWORD: server password (Compose default: opencode)
  BUN_VERSION, UV_VERSION, OPENCODE_VERSION: source-build version overrides
  (defaults in versions.env). Other Compose settings remain available via env.

Examples:
  ./start.sh --proxy http://127.0.0.1:7890 --build
  ./start.sh --bind 127.0.0.1 --port=8090
  ./start.sh --build -- --wait --timeout 60
EOF
}

fail() {
    printf 'start.sh: %s\nTry ./start.sh --help\n' "$1" >&2
    exit 2
}

build=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --) shift; break ;;
        --build|--build=true) build=true; shift; continue ;;
        --no-build|--build=false) build=false; shift; continue ;;
        --disable-proxy)
            export OPENCODE_HTTP_PROXY= OPENCODE_HTTPS_PROXY=
            export HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= NO_PROXY=
            export http_proxy= https_proxy= all_proxy= no_proxy=
            shift; continue ;;
        --proxy|--proxy=*|--http-proxy|--http-proxy=*|--https-proxy|--https-proxy=*|\
        --no-proxy|--no-proxy=*|--port|--port=*|--bind|--bind=*|\
        --image|--image=*|--config-source|--config-source=*|--skills-source|--skills-source=*)
            option=${1%%=*}
            case "$1" in
                *=*) value=${1#*=}; shift ;;
                *)
                    [ "$#" -ge 2 ] || fail "$option requires a value"
                    case "$2" in --*|-h) fail "$option requires a value" ;; esac
                    value=$2; shift 2 ;;
            esac
            case "$option" in
                --proxy) export OPENCODE_HTTP_PROXY="$value" OPENCODE_HTTPS_PROXY="$value" ;;
                --http-proxy) export OPENCODE_HTTP_PROXY="$value" ;;
                --https-proxy) export OPENCODE_HTTPS_PROXY="$value" ;;
                --no-proxy) export NO_PROXY="$value" ;;
                *)
                    [ -n "$value" ] || fail "$option requires a non-empty value"
                    case "$option" in
                        --port)
                            case "$value" in *[!0-9]*) fail "invalid port: $value" ;; esac
                            [ "${#value}" -le 5 ] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ] \
                                || fail "port must be between 1 and 65535"
                            export OPENCODE_PORT="$value" ;;
                        --bind) export OPENCODE_BIND_ADDRESS="$value" ;;
                        --image) export OPENCODE_IMAGE="$value" ;;
                        --config-source) export OPENCODE_CONFIG_SOURCE="$value" ;;
                        --skills-source) export OPENCODE_SKILLS_SOURCE="$value" ;;
                    esac ;;
            esac ;;
        *) fail "unknown argument: $1 (Compose arguments must follow --)" ;;
    esac
done

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
export BUN_VERSION UV_VERSION OPENCODE_VERSION

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
# A separate fallback lets Compose's .env supply OPENCODE_CONFIG_SOURCE.
# Compose resolves relative bind sources against the repository directory.
if [ -d "$HOME/.config/opencode" ]; then
    OPENCODE_DEFAULT_CONFIG_SOURCE="$HOME/.config/opencode"
else
    OPENCODE_DEFAULT_CONFIG_SOURCE="$workspace/config/opencode"
fi
export OPENCODE_DEFAULT_CONFIG_SOURCE

# build args interpolate from versions.env; the running container inherits the
# proxy settings resolved by Compose from flags, environment, and .env.
if [ "$build" = true ]; then
    compose_local() {
        if [ -f "$workspace/compose.override.yaml" ]; then
            docker compose --project-directory "$workspace" \
                -f "$workspace/compose.yaml" \
                -f "$workspace/compose.build.yaml" \
                -f "$workspace/compose.override.yaml" "$@"
        else
            docker compose --project-directory "$workspace" \
                -f "$workspace/compose.yaml" \
                -f "$workspace/compose.build.yaml" "$@"
        fi
    }

    # Compose 5.6.0 does not forward network.host as a Bake --allow grant.
    # Let Compose resolve interpolation, extends, proxy args, and overrides;
    # then run that exact definition with an explicit, narrowly scoped grant.
    bake_file=$(mktemp)
    trap 'rm -f "$bake_file"' EXIT
    trap 'exit 1' HUP INT TERM
    compose_local build --print opencode > "$bake_file"
    docker buildx bake --file "$bake_file" \
        --allow=network.host --allow="fs.read=$workspace" --load opencode
    rm -f "$bake_file"
    trap - EXIT HUP INT TERM

    # Only arguments following -- remain, with their quoting preserved.
    compose_local up -d --no-build "$@"
    exit
fi

# No explicit files: Compose discovers compose.yaml and compose.override.yaml.
exec docker compose --project-directory "$workspace" up -d "$@"
