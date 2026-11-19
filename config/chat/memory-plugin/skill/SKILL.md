---
name: workspace-memory
description: Use when the user asks to recall, save, edit, or delete persistent workspace memory through the workspace memory CLI or MCP bridge, or explicitly enables this workflow. Provides portable access to Markdown and YAML memory.
---

# Workspace Memory

Use the existing OpenCode memory tools when available. In another harness, use
the standalone CLI. It needs Bun, not an OpenCode server or an LLM service.
When the workspace-memory MCP server is configured, its `memory_recall`,
`memory_search`, `memory_read`, `memory_record`, `memory_update`, and `memory_delete` tools provide
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
JSON tool arguments instead of shell input. `memory_read` takes `name`, optional
`section` (exact heading title without `#`), `offset`, and `limit`. Restart the read if revisions
change between pages. `memory_record` requires a unique `requestId` selected
before the first call; retry with the same ID and content after a lost response.
`memory_update` requires `expectedRevision` and the complete Markdown body, or
the complete selected section including its heading when `section` is supplied.
Omit `name` for `MEMORY.md` or give an existing session filename.
`memory_delete` takes the existing session filename and its current `expectedRevision`.
Inspect `isError` before treating a call as successful. No separate CLI write or
manual index rebuild is needed after a successful MCP call.

## Setup

The user/harness configures these absolute paths:

```sh
export MEMORY_CLI=/absolute/path/to/opencode-docker/memory.sh
export MEMORY_ROOT=/absolute/path/to/memory-workspace
```

If the paths are unknown, ask for them. Do not guess a private memory location.
The explicit absolute memory root contains `.memory-db/shared.sqlite` and optionally
`.memory-db/private.sqlite`. SQLite is the only runtime backend. The CLI defaults to shared access. Space selection is
caller-controlled, not authentication. Use private memory only when the user's
workflow calls for it. Do not use this bridge to bypass a temporary/no-memory
mode, harness permissions, or a request not to record.

The logical CLI name stays `MEMORY.md`. Reads never discover Markdown or initialize
databases. Normal writes may initialize empty spaces. Explicit administration uses
`memory.sh init --root /absolute/database-root --space shared` or
`memory.sh import --root /absolute/database-root --source /absolute/markdown-root --space shared --dry-run`.
Import is explicit, preserves source bytes and leaves source files untouched.
Review the README before administration; it is outside routine agent recording.
Record results use `logicalPath` for the logical SQLite identifier and `name`
for the `.md` document name; the body remains Markdown in SQLite. Physical
database/backup paths appear only in administrative results. Both schema v1 and
explicitly upgraded v2 support record and update; deletion requires v2.
`upgrade-sync --dry-run` and
`upgrade-sync` are operator administration with stopped writers and a v1 backup;
ordinary tools never upgrade databases. Conflicts/restoration need future tooling.

## Read

Recall returns summary/navigation by default. If there is no summary heading and
the body is at most 2000 characters, it returns the full body (`mode: full`);
otherwise `mode: overview` applies. Short memories need no duplicate summary.

Recall loads only summary/navigation, plus five recent records. Recognized titles
are `速览摘要`, `摘要`, `Summary`, `Quick summary`, and navigation titles
`内部导航与按需提取索引`, `内部索引`, `Navigation`, `Index` (case-sensitive).
Missing summaries are explicit: use the returned section titles to read details,
or read MEMORY.md directly. Recall text is capped at 10000 characters; section
descriptors at 100 (`sectionsTotal`/`sectionsTruncated` indicate more).
Page truncated summary/navigation with an explicit section read.

```sh
"$MEMORY_CLI" recall --root "$MEMORY_ROOT" --space shared
"$MEMORY_CLI" search "topic keywords" --root "$MEMORY_ROOT" --space shared
"$MEMORY_CLI" read MEMORY.md --root "$MEMORY_ROOT" --space shared
"$MEMORY_CLI" read MEMORY.md --section "速览摘要" --limit 2000
```

Use returned filenames to read matching records. `read --offset N --limit N`
pages the Markdown body by character offset. Metadata is returned separately.
With `--section`, text includes the heading and nested sections through the next
same/higher-level ATX heading; fenced code headings are ignored. Offset/total
are section-relative. Missing or duplicate titles fail explicitly. Session
records support section selection; INDEX.md supports only whole-body pagination.
Revision and metadata always cover the full file. Before whole-file update, omit
`--section` and read every body page. For section update, read all selected pages.
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

For whole-file `update`, first read the entire target body, including all
truncated pages. Omit `name` to update `MEMORY.md`; merge only enduring
facts/preferences there and mark obsolete facts deprecated. To update an
existing session record, include its exact `name`. Pass `content` (the complete
updated Markdown body, without YAML) and `expectedRevision` from that read.
The stored summary stays unchanged. On a stale revision, read again and merge.

```sh
"$MEMORY_CLI" update --root "$MEMORY_ROOT" --space shared --input /path/to/update.json
```

For `delete`, act only at the user's explicit request. First read the named
session record, then pass `name` and its current `expectedRevision` in the JSON
input. Use the same space for both operations. The space must already be SQLite
v2. `MEMORY.md` and `INDEX.md` are protected. Deletion hides the record from
normal results and export but retains its history; do not try to recreate it.

Choose one space per write. Input cannot override identity/space; use the flag.
The CLI maintains frontmatter, IDs, revisions, locks, and generated indexes.
Do not also edit `INDEX.md`. Keep sensitive credentials out of memory.

## Results

For targeted `update`, include optional `section` in JSON/tool arguments, using
an exact existing heading title. Read every selected-section page first. Supply
the merged section as `content`, including its unchanged heading title and level
and all nested subsections. Only lower-level nested headings may follow, and code
fences must close. Other sections remain unchanged; `expectedRevision` still
covers the full file. Reread after conflicts. Keep the summary/navigation in sync
with changed facts, using the latest revision for subsequent updates. Renaming
headings or restructuring multiple topics requires a whole-file update.

Success: exit 0, one JSON object on stdout. Errors: JSON on stderr, exit 2 for
usage/input errors or 1 for operation failures. Read error messages before
retrying. `--help` prints usage and input shapes without reading memory.
The CLI returns no automatic assistant response and never calls an LLM.
