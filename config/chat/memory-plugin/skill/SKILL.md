---
name: workspace-memory
description: Use when the user asks to recall or save persistent workspace memory through a shell-capable harness, or explicitly enables this memory workflow. Provides a portable CLI for Markdown and YAML memory.
---

# Workspace Memory CLI

Use the existing OpenCode memory tools when available. In another harness, use
the standalone CLI. It needs Bun, not an OpenCode server or an LLM service.

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
