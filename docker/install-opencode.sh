#!/bin/sh
# Install the pinned native binary without package-manager postinstall scripts.
set -eu

version=${1:?expected OpenCode version}
architecture=${2:?expected Docker target architecture}
destination=${3:?expected destination binary path}

case "$architecture" in
    amd64) target=linux-x64-baseline ;;
    arm64) target=linux-arm64 ;;
    *) echo "unsupported architecture: $architecture" >&2; exit 1 ;;
esac

case "$version" in
    1.*)
        url="https://github.com/anomalyco/opencode/releases/download/v${version}/opencode-${target}.tar.gz"
        member=opencode
        strip=0
        ;;
    2.*)
        url="https://registry.npmjs.org/@opencode/cli-${target}/-/cli-${target}-${version}.tgz"
        member=package/bin/opencode
        strip=2
        ;;
    *) echo "unsupported OpenCode version: $version" >&2; exit 1 ;;
esac

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
curl --retry 5 --retry-delay 5 --retry-all-errors -fsSL "$url" -o "$temporary/archive.tgz"
tar -xzf "$temporary/archive.tgz" --strip-components="$strip" -C "$temporary" "$member"
install -m 0755 "$temporary/opencode" "$destination"
