#!/bin/sh
# Entrypoint for the OpenCode runtime.
#
#   1. Unify HOME, XDG paths, and CARGO_HOME around OPENCODE_HOME (falling back
#      to HOME) so OpenCode, bun, and cargo all write inside one writable home.
#   2. Initialize and own the runtime-managed directories (config, data, cache,
#      cargo). The project checkout and any read-only mounts are never touched.
#   3. Mirror the read-only configuration source at /opt/opencode-config-source
#      into the instance configuration directory on every start, so source
#      updates and deletions take effect while generated dependencies persist.
#      Without a source, the baked neutral defaults seed an empty config once.
#   4. Drop root to OPENCODE_UID:OPENCODE_GID (using setpriv from util-linux),
#      or run directly when already unprivileged, then exec the command.
#
# `docker run <image> Rscript script.R` and other extension commands are passed
# through unchanged.
set -eu

baked_config=/usr/local/share/opencode/config
source_config=${OPENCODE_CONFIG_INPUT:-/opt/opencode-config-source}
auth_source=${OPENCODE_AUTH_INPUT:-/opt/opencode-auth-source}
target_uid=${OPENCODE_UID:-1000}
target_gid=${OPENCODE_GID:-1000}
target_home=${OPENCODE_HOME:-${HOME:-/home/bun}}

export HOME="$target_home"
: "${XDG_CONFIG_HOME:=$target_home/.config}"
: "${XDG_DATA_HOME:=$target_home/.local/share}"
: "${XDG_CACHE_HOME:=$target_home/.cache}"
: "${CARGO_HOME:=$target_home/.cargo}"
: "${RUSTUP_HOME:=/usr/local/rustup}"
export XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME CARGO_HOME RUSTUP_HOME
export PATH="$CARGO_HOME/bin:$HOME/.local/bin:$PATH"

config_dir="$XDG_CONFIG_HOME/opencode"
data_dir="$XDG_DATA_HOME/opencode"
cache_dir="$XDG_CACHE_HOME/opencode"

ensure_identity() {
    # Node's os.userInfo() and other developer tools need a passwd entry, not
    # just a numeric effective UID. Existing system accounts are reused.
    for value in "$target_uid" "$target_gid"; do
        case "$value" in
            ''|*[!0-9]*) echo "opencode-entrypoint: UID/GID must be numeric" >&2; exit 1 ;;
        esac
    done
    if ! getent group "$target_gid" >/dev/null; then
        groupadd --gid "$target_gid" "opencode-$target_gid"
    fi
    if ! getent passwd "$target_uid" >/dev/null; then
        useradd --no-create-home --uid "$target_uid" --gid "$target_gid" \
            --home-dir "$target_home" --shell /bin/bash "opencode-$target_uid"
    fi
    account=$(getent passwd "$target_uid")
    USER=${account%%:*}
    LOGNAME=$USER
    export USER LOGNAME
}

# Dependency files generated in the writable configuration mirror survive a
# restart. A source package.json is still authoritative for local plugins.
keep_generated() {
    case "$1" in
        node_modules|package.json|bun.lock|bun.lockb|package-lock.json|.gitignore) return 0 ;;
        *) return 1 ;;
    esac
}

skip_source() {
    case "$1" in
        node_modules|bun.lock|bun.lockb|package-lock.json|.gitignore|.git) return 0 ;;
        *) return 1 ;;
    esac
}

prepare_dirs() {
    mkdir -p "$config_dir" "$data_dir" "$cache_dir" "$HOME/.bun" "$HOME/.local/bin" "$CARGO_HOME/bin"
}

own_dirs() {
    chown "$target_uid:$target_gid" \
        "$target_home" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$HOME/.local" "$HOME/.local/bin"
    chown -R "$target_uid:$target_gid" \
        "$config_dir" "$data_dir" "$XDG_CACHE_HOME" "$CARGO_HOME" "$HOME/.bun"
}

mirror_source_config() {
    # Remove previously mirrored entries so deleted agents do not linger, but
    # keep generated dependency files. Then copy source entries, minus the
    # generated ones, so no dependency tree or secret cache is baked in.
    for existing in "$config_dir"/* "$config_dir"/.[!.]* "$config_dir"/..?*; do
        [ -e "$existing" ] || [ -L "$existing" ] || continue
        base=${existing##*/}
        if keep_generated "$base"; then
            continue
        fi
        rm -rf "$existing"
    done
    for entry in "$source_config"/* "$source_config"/.[!.]* "$source_config"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        base=${entry##*/}
        if skip_source "$base"; then
            continue
        fi
        cp -R --no-preserve=ownership "$entry" "$config_dir/"
    done
}

seed_baked_config() {
    if [ ! -f "$config_dir/opencode.json" ] && [ ! -f "$config_dir/opencode.jsonc" ] && [ -d "$baked_config" ]; then
        cp -R --no-preserve=ownership "$baked_config/." "$config_dir/"
    fi
}

sync_profile() {
    [ -n "${OPENCODE_PROFILE_INPUT:-}" ] || return 0
    if [ ! -f "$OPENCODE_PROFILE_INPUT/opencode.jsonc" ]; then
        echo "opencode-entrypoint: profile opencode.jsonc is missing" >&2
        return 1
    fi
    profile_dir="$config_dir/.runtime-profile"
    mkdir -p "$profile_dir"
    for entry in "$OPENCODE_PROFILE_INPUT"/* "$OPENCODE_PROFILE_INPUT"/.[!.]*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        base=${entry##*/}
        skip_source "$base" && continue
        cp -R --no-preserve=ownership "$entry" "$profile_dir/"
    done
    if [ -d "$profile_dir/agents" ]; then
        mkdir -p "$config_dir/agents"
        cp -R --no-preserve=ownership "$profile_dir/agents/." "$config_dir/agents/"
    fi
    # OpenCode natively loads this between global and project configuration.
    # Keep it in the writable mirror rather than the read-only source.
    : "${OPENCODE_CONFIG:=$profile_dir/opencode.jsonc}"
    export OPENCODE_CONFIG
}

sync_config() {
    if [ -d "$source_config" ]; then
        mirror_source_config
    else
        seed_baked_config
    fi
    sync_profile
    chmod -R u+rwX "$config_dir"
}

# Optional credentials are imported once into writable state so token refreshes
# persist. Mount the input directory read-only, rather than individual state
# files that would prevent initialization and refresh.
seed_auth() {
    for name in auth.json account.json; do
        if [ -f "$auth_source/$name" ] && [ ! -e "$data_dir/$name" ]; then
            cp --no-preserve=ownership "$auth_source/$name" "$data_dir/$name"
            chmod 600 "$data_dir/$name"
        fi
    done
}

if [ "$#" -eq 0 ]; then
    set -- opencode
fi

if [ "$(id -u)" = "0" ]; then
    ensure_identity
    prepare_dirs
    own_dirs
    sync_config
    seed_auth
    chown -R "$target_uid:$target_gid" "$config_dir" "$data_dir"
    exec setpriv --reuid="$target_uid" --regid="$target_gid" --clear-groups -- "$@"
fi

# Already unprivileged: initialize when HOME is writable, otherwise warn and
# still run the requested command (for example a read-only Rscript invocation).
if prepare_dirs && sync_config && seed_auth; then
    :
else
    echo "opencode-entrypoint: warning: could not initialize HOME=$HOME; continuing" >&2
fi
exec "$@"
