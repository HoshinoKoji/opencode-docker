---
name: workspace-memory
description: Use when the user asks to recall or save persistent workspace memory through the workspace memory CLI or MCP bridge, or explicitly enables this workflow. Provides portable access to Markdown and YAML memory.
---

# Workspace Memory

Use the existing OpenCode memory tools when available. In another harness, use
the standalone CLI. It needs Bun, not an OpenCode server or an LLM service.
When the workspace-memory MCP server is configured, its `memory_recall`,
`memory_search`, `memory_read`, `memory_record`, and `memory_update` tools provide
the same storage workflow directly.

## MCP bridge

The operator installs dependencies once with
`bun install --cwd /absolute/path/to/opencode-docker/config/chat/memory-mcp --frozen-lockfile`
and configures the client's stdio command as
`/absolute/path/to/opencode-docker/memory-mcp.sh`, with `MEMORY_ROOT` or `--root`.
See the repository README for Antigravity's `mcpServers` example. Startup never
installs dependencies. The default policy permits shared memory; `--space private`
and `--space both` are explicit operator opt-ins. Tool arguments cannot expand
that policy. `--read-only` hides write tools and denies writes. External MCP
does not authenticate harness agents; respect plan/read-only and temp/no-memory
rules and requests not to record. Disable memory access in no-memory contexts.

Use `scope` to narrow a tool call; with both spaces enabled, every write must
select `shared` or `private`. Follow the read/merge/record workflow below using
JSON tool arguments instead of shell input. `memory_read` takes `name`, `offset`,
and `limit`; page until the whole body is read. Restart the read if revisions
change between pages. `memory_record` requires a unique `requestId` selected
before the first call; retry with the same ID and content after a lost response.
`memory_update` requires the complete Markdown body and `expectedRevision`.
Inspect `isError` before treating a call as successful. No separate CLI write or
manual index rebuild is needed after a successful MCP call.

## Setup

The user/harness configures these absolute paths:

```sh
export MEMORY_CLI=/absolute/path/to/opencode-docker/memory.sh
export MEMORY_ROOT=/absolute/path/to/memory-workspace
```

If the paths are unknown, ask for them. Do not guess a private memory location.
The memory root contains shared `MEMORY.md` and `.sessions/`, with private memory
under `.sessions/casual/`. The CLI defaults to shared access. Space selection is
caller-controlled, not authentication. Use private memory only when the user's
workflow calls for it. Do not use this bridge to bypass a temporary/no-memory
mode, harness permissions, or a request not to record.

## Read

```sh
"$MEMORY_CLI" recall --root "$MEMORY_ROOT" --space shared
"$MEMORY_CLI" search "topic keywords" --root "$MEMORY_ROOT" --space shared
"$MEMORY_CLI" read MEMORY.md --root "$MEMORY_ROOT" --space shared
```

Use returned filenames to read matching records. `read --offset N --limit N`
pages the Markdown body by character offset. Metadata is returned separately.
`--space private` selects private memory; `--space both` is supported for reads.
Search matches all literal whitespace-separated terms, including Chinese.
Integrate relevant context naturally and prioritize the user's current words.

## Write

Write a JSON input file using your harness's normal file tools, or pipe JSON to
stdin with `--input -`. This avoids shell-escaping conversation text.

For `record`, required strings are `topic` (English/pinyin slug), `goal`,
`conclusion`, and `details` (Markdown). Optional strings are `decisions`,
`nextSteps`, and `preferences`. Save a useful topic summary and details, not a
transcript. Use a unique, non-secret request ID per record; reuse it for retries.

```sh
"$MEMORY_CLI" record --root "$MEMORY_ROOT" --space shared \
  --input /path/to/record.json --request-id harness-session-topic-unique-id
```

For `update`, first read the entire `MEMORY.md` body, including all truncated
pages. Merge only enduring facts/preferences into its existing organization.
Pass `content` (the complete updated Markdown body, without YAML) and
`expectedRevision` from that read. Preserve relevant information; mark obsolete
facts deprecated. On a revision conflict, read again and merge.

```sh
"$MEMORY_CLI" update --root "$MEMORY_ROOT" --space shared --input /path/to/update.json
```

Choose one space per write. Input cannot override identity/space; use the flag.
The CLI maintains frontmatter, IDs, revisions, locks, and generated indexes.
Do not also edit `INDEX.md`. Keep sensitive credentials out of memory.

## Results

Success: exit 0, one JSON object on stdout. Errors: JSON on stderr, exit 2 for
usage/input errors or 1 for operation failures. Read error messages before
retrying. `--help` prints usage and input shapes without reading memory.
The CLI returns no automatic assistant response and never calls an LLM.
