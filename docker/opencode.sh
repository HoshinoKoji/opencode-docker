#!/bin/sh
# Lazy, version-pinned native CLI cache. The entrypoint has already prepared
# writable state and dropped privileges; direct calls work with XDG/HOME too.
set -eu

fail() { echo "opencode-runtime: $*" >&2; exit 1; }
version=${OPENCODE_VERSION:-${OPENCODE_DEFAULT_VERSION:-}}
# Support exact stable V2 package releases only, never npm ranges or tags.
case "$version" in ''|*[!0-9.]*) fail "OPENCODE_VERSION must be an exact stable V2 version" ;; esac
printf '%s\n' "$version" | grep -Eq '^2\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' \
    || fail "OPENCODE_VERSION must be an exact stable V2 version (for example 2.3.2)"

data=${XDG_DATA_HOME:-${HOME:?HOME is required}/.local/share}
case "$data" in /*) ;; *) fail "XDG_DATA_HOME must be absolute" ;; esac
# Separate CPU variants when a volume is moved to another host. Platform
# selection itself stays with the official package's postinstall script.
platform=$(uname -s)-$(uname -m)
if [ "$(uname -m)" = x86_64 ]; then
    if grep -qw avx2 /proc/cpuinfo; then platform=$platform-avx2; else platform=$platform-baseline; fi
fi
root="$data/opencode/runtime/v1/$platform"
final="$root/$version"
mkdir -p "$root"
original_umask=$(umask)
umask 077
# flock releases automatically on crash. Close the descriptor before exec so
# a long-running server never retains the installation lock.
exec 9>"$root/.install.lock"
flock -x 9
# A killed publisher can leave a stage behind. Holding the same lock proves
# there is no live publisher using it (the installer inherits the lock too).
for abandoned in "$root"/.stage-*; do
    [ -e "$abandoned" ] || [ -L "$abandoned" ] || continue
    rm -rf -- "$abandoned"
done

valid_cache() {
    [ -d "$final" ] && [ ! -L "$final" ] &&
    [ -f "$final/opencode" ] && [ ! -L "$final/opencode" ] &&
    [ -x "$final/opencode" ] && [ -f "$final/verified" ] &&
    [ ! -L "$final/verified" ] || return 1
    digest=$(sha256sum "$final/opencode")
    [ "$(cat "$final/verified")" = "$version $platform ${digest%% *}" ]
}

if ! valid_cache; then
    echo "opencode-runtime: installing @opencode/cli@$version ($platform)" >&2
    stage=$(mktemp -d "$root/.stage-$version-XXXXXX")
    trap 'rm -rf "$stage"' EXIT
    trap 'exit 1' HUP INT TERM
    # Isolate Bun's global installation, then retain only its selected native
    # binary. This avoids absolute package-manager symlinks across the rename.
    if ! BUN_INSTALL="$stage/bun" bun install -g --trust "@opencode/cli@$version" >&2; then
        fail "installation of $version failed; retry with network access"
    fi
    cp -L "$stage/bun/bin/opencode" "$stage/opencode" \
        || fail "installer did not produce a native CLI for $version"
    chmod 755 "$stage/opencode"
    actual=$("$stage/opencode" --version) || fail "installed CLI failed verification"
    [ "${actual#opencode v}" = "$version" ] \
        || fail "installed CLI version mismatch: expected $version, got $actual"
    rm -rf "$stage/bun"
    digest=$(sha256sum "$stage/opencode")
    printf '%s\n' "$version $platform ${digest%% *}" > "$stage/verified"
    # An invalid entry is replaced only after the replacement is verified.
    # All publishers hold this lock; no partial install is ever a cache hit.
    rm -rf "$final"
    mv "$stage" "$final"
    trap - EXIT HUP INT TERM
fi
flock -u 9
exec 9>&-
umask "$original_umask"
exec "$final/opencode" "$@"
