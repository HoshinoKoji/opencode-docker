#!/bin/sh
set -eu
workspace=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bun "$workspace/config/chat/memory-plugin/cli.js" "$@"
