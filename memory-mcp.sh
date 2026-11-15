#!/bin/sh
set -eu
workspace=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bridge="$workspace/config/chat/memory-mcp"
if ! command -v bun >/dev/null 2>&1; then
  echo "memory-mcp: Bun with built-in YAML support is required; add bun to the client process PATH." >&2
  exit 1
fi
if [ ! -d "$bridge/node_modules/@modelcontextprotocol/server" ] || [ ! -d "$bridge/node_modules/zod" ]; then
  echo "memory-mcp: dependencies missing. Run: bun install --cwd \"$bridge\" --frozen-lockfile" >&2
  exit 1
fi
exec bun --no-install "$bridge/server.js" "$@"
