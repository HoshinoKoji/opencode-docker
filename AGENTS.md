# AGENTS.md

This repository publishes a general-purpose OpenCode runtime image and runs a personal chat workspace on top of it. It contains the runtime `Dockerfile`, a Docker Compose setup, shared configuration, Markdown notes, and focused runtime checks under `tests/`; see `README.md` for container usage.

## Environment

- Tool versions are pinned in `versions.env`; it assigns defaults only, so explicit environment overrides win. It is the single source of truth for local builds (`./start.sh --build`) and the publish workflow.
- Local `start.sh --build` exports a resolved Bake definition through `docker compose build --print`, runs Buildx with explicit `network.host` and repository-scoped `fs.read` grants plus `--load`, then starts Compose with `--no-build`. This bypasses Compose v5.6.0's missing host-network grant forwarding; that release no longer reads `COMPOSE_BAKE`.
- `config/opencode/` holds the neutral development defaults baked into the runtime. `config/chat/` holds the `serious`/`casual`/`temp` chat agents and memory permissions, and is loaded only by the chat workspace. `config/skills/` holds skills shared by every project. Do not reintroduce chat-specific defaults into `config/opencode/`.
- `compose.runtime.yaml` is a shared service fragment consumed with Compose `extends` (not `include`); `compose.yaml` is the chat workspace and `compose.build.yaml` builds the runtime locally. Consuming files declare the `opencode-config`, `opencode-data`, and `opencode-cache` volumes and the read-only config/skills bind sources themselves.
- A shared configuration source is mounted read-only at `/opt/opencode-config-source`. The entrypoint mirrors it into the writable instance `opencode-config` volume on every start, excluding generated dependencies, so source edits and deletions take effect on restart while the host source stays unmodified. Without a source it seeds the baked neutral defaults.
- Chat settings overlay those shared preferences: `/opt/opencode-profile-source` is mirrored into the instance configuration, its agents are installed there, and its JSONC is loaded by native `OPENCODE_CONFIG` precedence before project configuration. Model/provider preferences remain shared.
- The base image contains Bun, uv, OpenCode, and common system tools. Bun and uv come from pinned official images; OpenCode V2 is installed globally with Bun into `/usr/local`. Node, Rust, and C/C++ toolchains are downstream extensions; copy the examples in `examples/`. The entrypoint retains writable `CARGO_HOME` support for Rust extensions, which can add their own Cargo volume.
- The runtime image is published to `ghcr.io/hoshinokoji/opencode-runtime` for `linux/amd64` only, from manual runs or `runtime-v*` tags. No build uses an implicit `latest`.
- The image entrypoint unifies `HOME`/XDG/`CARGO_HOME` around `OPENCODE_HOME`, owns the runtime-managed directories, drops root to `OPENCODE_UID`/`OPENCODE_GID` with `setpriv`, and execs the given command. Extension images and `Rscript` invocations are passed through unchanged.
- Run focused checks with `uv run --no-project --with pytest pytest tests -q` and `bun test tests/memory-plugin.test.js tests/memory-cli.test.js`. The Python suite checks real plugin loading when the OpenCode CLI is installed. The manual/tag publish workflow also validates Compose, runs image smoke checks, and runs the Bun memory tests inside the image. Host credentials may be imported once from the read-only `/opt/opencode-auth-source` directory into writable instance state.

This project defines three switchable custom primary agents: `serious` (the default, writes to shared memory), `casual` (writes to its own private memory), and `temp` (temporary chat, with no memory access or recording). Each agent prompt defines its conversational style; this file defines memory file formats and procedures.

## Communication principles (all agents)

- Prefer affirmative descriptions that explain what something is, its characteristics, and when it applies.
- Avoid defining things primarily through negation or exclusion (for example, “X is ..., not ..., and not ...”). When distinctions matter, describe each option positively and explain its scope. Use a brief negation when it is necessary to correct a misunderstanding.

## Conversation memory workflow

### Memory plugin (`serious`, `casual`, `build`, and `plan`)
- Prefer the chat-profile `memory_recall`, `memory_search`, `memory_read`, `memory_record`, and `memory_update` tools (Code Mode: `tools.memory.*`). The plugin uses the host's execution-context agent, not a model-supplied identity. `plan` can use only recall/search/read; `temp`, `general`, `explore`, and other agents cannot use these tools.
- Call `recall` for the startup review, then `search`/`read` for relevant details. `record` saves Markdown with YAML frontmatter and rebuilds the index; do not also edit the index manually. It adds a stable call suffix to the topic slug to avoid collisions. Dates use UTC. Recall and INDEX reads derive their entries from records, so missing/stale indexes do not hide synced records.
- Reads default to shared memory for `serious`, `build`, and `plan`, both spaces for `casual`; writes default to shared for `serious` and `build`, private for `casual`. `build` and `plan` use shared memory only. A `casual` shared write requires the user's explicit sharing request plus `scope: "shared", share: true`.
- `plan` must never record, update, reindex, or otherwise write memory, including through CLI commands or direct file edits. Its file/CLI fallback is shared reads only. `build` must not access private memory through tools, CLI, or files.
- Before `update`, read the complete `MEMORY.md` body (page through truncated results), merge enduring changes, and supply its `expectedRevision`. Tool reads return metadata separately; pass only the Markdown body to update. The plugin preserves the stable ID, creation time, and custom metadata. If a conflict occurs, read again and merge; do not blindly retry stale content. All content, consent, and mode-switching rules below still apply.
- If these tools are unavailable, use the file workflow below. Markdown with YAML frontmatter is the source of truth; legacy plain Markdown remains readable. Keep IDs stable when editing/syncing. The containing directory defines shared/private scope. `.backups/` directories contain migration originals and are excluded from plugin recall/search.
- Other shell-capable harnesses can use `memory.sh` with an explicit `--root`/`MEMORY_ROOT` and `--space shared|private|both` (default shared, both for reads only). It reuses the store without authenticating an agent identity; each harness retains its own memory permissions and consent rules. Writes accept JSON via `--input FILE|-`; record retries should reuse `--request-id`. The opt-in portable skill is `config/chat/memory-plugin/skill/SKILL.md`.
- External MCP clients can launch `memory-mcp.sh` after an explicit `bun install --cwd config/chat/memory-mcp --frozen-lockfile`. This isolated package reuses `MemoryStore` with a configured external policy, without an OpenCode execution identity. Require `--root`/`MEMORY_ROOT`; shared is the default, private/both require startup opt-in, and both requires one explicit scope per write. `--read-only` filters write tools and denies writes. Harness plan/temp and recording-consent rules still apply. Record calls require a stable `requestId`; update calls require `expectedRevision`. Run its real stdio integration suite with `bun test ./config/chat/memory-mcp/server.test.js`. Keep MCP dependencies out of the OpenCode plugin package and preserve configuration mirroring behavior.

### File conventions
- Shared memory (`serious` and `build` read and write; `casual` and `plan` may read): `.sessions/MEMORY.md`, `.sessions/YYYY-MM-DD-<topic>.md`, and `.sessions/INDEX.md`. Tools still accept the logical name `MEMORY.md`. Reads fall back to legacy root `MEMORY.md`; if both paths exist, reconcile the conflict before proceeding. `manage.js relocate-shared --dry-run` previews an explicit shared-only move; omit `--dry-run` to back up and relocate byte-for-byte. Shared long-term updates also relocate legacy files under the store lock after validating the revision. Metadata migration preserves the existing physical location.
- Private `casual` memory (read and written by `casual`): `.sessions/casual/MEMORY.md`, `.sessions/casual/YYYY-MM-DD-<topic>.md`, and `.sessions/casual/INDEX.md`. `serious`, `build`, and `plan` do not access this subdirectory.
- Use a short English or pinyin slug for each record's topic; if that slug is already used on the same day, choose another unique one. YAML frontmatter stores `schema_version: 1`, stable `id`, `type` (`session` or `long_term`), `date`, `topic`, `summary`, `created_at`, and `updated_at`; `preferences` is optional. Quote dates/timestamps as strings. Keep substantive discussion in the Markdown body. Indexes are derived in **reverse chronological order**, one line per record: `date | filename topic | summary | preferences`; store lasting information in records, not only in INDEX.md. Keep only still-relevant entries in long-term memory; mark obsolete entries as “deprecated” in place rather than deleting them.

### At the start of each session (`serious`, `casual`, `build`, and `plan`; proactively, without prompting)
1. `serious`, `build`, and `plan` read shared `.sessions/MEMORY.md` (legacy root fallback as above) and approximately the five most recent entries in `.sessions/INDEX.md`. `casual` also reads `.sessions/casual/MEMORY.md` and approximately the five most recent entries in `.sessions/casual/INDEX.md`. Skip files that do not exist.
2. Open relevant past records for details. `serious`, `build`, and `plan` search only shared memory; `casual` may search both spaces.
3. Use the review to inform this session. When past memory conflicts with what the user says now, follow the user's current statement and update memory in the space this mode may write to. `casual` does not automatically update shared memory.

### Recording conversations
- `serious` and `build`: by default, make one record in shared memory when each topic or task concludes; do not read or write `.sessions/casual/`.
- `plan`: use shared memory to inform planning and summarize conclusions in the response; never save a memory record or update memory.
- `casual`: by default, make one record in its private memory when each topic or task concludes; write to shared memory only when the user explicitly asks to share specific information.
- The writing agents (`serious`, `casual`, and `build`) need not record every reply. If a topic is unfinished when switching topics or ending the session, record the current progress and open questions.
- `temp`: do not read or write either memory space, review past conversations, or retroactively record chats in this mode. To save a discussion, ask the user to switch to another mode and discuss what to record there.
- To isolate previously loaded session context in `temp`, start a new session before switching to `temp`; changing agents within one session does not erase prior messages.
- Likewise, start a new session when switching from `casual` to `serious`, `build`, or `plan` if private `casual` content needs to be isolated; tool permissions cannot erase earlier messages in the same session.
- If the user explicitly says “do not record,” do not create a conversation record or update the index or long-term memory for that topic. Do not retroactively record `casual` conversations after switching to `serious` or `build`.

When recording:
1. Create `YYYY-MM-DD-<topic>.md` in the current mode's memory space using the template below: a concise YAML summary followed by details that make it possible to resume the discussion later.
2. Rebuild `INDEX.md` in the same space from the record metadata. The plugin does this automatically. Legacy records retain their original summary/body and can be indexed without migration.
3. Merge only newly learned, enduring preferences or facts into that space's `MEMORY.md`. Organize `MEMORY.md` by coherent topics and rewrite existing bullets in place when state evolves; deduplicate and do not append dated fragments or turn it into a chronological log. Leave it untouched if there is nothing enduring to add. Exclude passwords, tokens, and other sensitive details that do not need to be retained.

### Conversation record template
```
---
schema_version: 1
id: "<unique stable ID>"
type: "session"
date: "YYYY-MM-DD"
topic: "<topic slug>"
summary: "<one-sentence conclusion>"
created_at: "<UTC ISO timestamp>"
updated_at: "<UTC ISO timestamp>"
preferences: "<optional key preferences>"
---
# <topic>
## Goal

## Details
- Background and request:
- Discussion and progress:
- Rationale and tradeoffs:
- Outcome and follow-up:

## Decisions and Next Steps
```

### Principles
- Keep the summary brief. Include enough concrete detail in the longer record for future retrieval and continuation: the user's original question or key wording, relevant background, important clarifications and changes, actions taken, reasoning and tradeoffs, output locations, and open questions. Record only what happened and is useful; omit empty template fields.
- Write memory files in natural, direct prose with high readability. State what the user shared, thought, or decided without tacking on defensive disclaimers, clinical/legalistic caveats, or lists of things the user did not mention or prove (such as “do not infer X from this,” “not a clinical diagnosis,” or “specific budget/details were not provided”). Keep operational rules in prompt files rather than repeating self-instructions inside memory entries.
- Follow the user's specific instructions about the scope, format, and level of detail. Otherwise, choose the detail level based on the topic's complexity and future retrieval value. A simple chat can have a short record; complex tasks need the important steps and decisions. Do not transcribe the entire exchange by default; include more of the user's wording or process when requested.
- When using memory to produce new work, integrate relevant context naturally instead of mechanically listing old entries, filenames, or phrases such as “according to past records.” Cite a specific record when the user asks for provenance or it helps verify a claim. Distinguish past statements from facts verified now, and prioritize the user's current instructions.
- When recording for the first time, create the appropriate directory, index, and long-term memory file as needed. If the directory is empty, simply say that there are no past sessions yet.
