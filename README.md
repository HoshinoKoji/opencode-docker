# OpenCode Runtime and Personal Workspace

Run OpenCode in a container with read-only access to shared configuration,
skills, and reference material, writable project directories, and persistent
session data. The personal workspace includes three chat agents with different
conversation and memory styles.

- [Quick start](#quick-start)
- [Everyday settings](#everyday-settings)
- [Chat agents and memory](#chat-agents-and-memory)
- [Workspace, mounts, and data](#workspace-mounts-and-data)
- [Developer guide](#developer-guide): build, extend, test, and publish the runtime

## Quick Start

The host needs Git, Docker, and modern Docker Compose with `extends` support.
From this repository directory, run:

```bash
./start.sh
```

Open **<http://127.0.0.1:14096>**. The default username and password are both
**`opencode`**. Configure a model provider in the interface on first use;
provider credentials are not required to start the container.

The service runs in the background and listens on `0.0.0.0:14096` by default.
For local-only access:

```bash
./start.sh --bind 127.0.0.1
```

For access from other devices, set a strong password before starting:

```bash
export OPENCODE_SERVER_PASSWORD='replace-with-your-password'
./start.sh
```

### Status, Logs, and Shutdown

```bash
docker compose ps
docker compose logs -f opencode
docker compose down
```

Session and authentication data live in persistent Docker volumes and survive
ordinary `docker compose down` and container recreation.

`./start.sh` defaults to `ghcr.io/hoshinokoji/opencode-runtime:latest` and
pulls on every start. `latest` follows the last successfully published stable
release. To start offline with an already-cached image and exact OpenCode CLI version:

```bash
./start.sh --no-pull
```

> **Migration:** `latest` has not yet been published. This checkout cannot create
> the registry tag; a successful stable release publish is required first.
> Until then, use `./start.sh --image ghcr.io/hoshinokoji/opencode-runtime:0.2.4`
> (add `--no-pull` if cached/offline), or `./start.sh --build` for the slim runtime.

## Everyday Settings

### Launcher Options

```bash
./start.sh --help
```

| Option | Purpose |
| --- | --- |
| `--proxy URL` | Set both HTTP and HTTPS proxies |
| `--http-proxy URL`, `--https-proxy URL` | Set either proxy separately |
| `--no-proxy HOSTS` | Comma-separated proxy bypass list |
| `--disable-proxy` | Clear all proxy variables passed to builds and containers |
| `--bind ADDRESS` | Listen address; default `0.0.0.0` |
| `--port PORT` | Listen port; default `14096` |
| `--config-source DIR` | Shared configuration source |
| `--skills-source DIR` | Shared skills source; default `config/skills` |
| `--image IMAGE` | Runtime image to use |
| `--pull`, `--no-pull` | Always pull (default), or never pull and use the cached image; last flag wins |
| `--build`, `--no-build` | Enable or disable a source build before startup |

Flags override environment and Compose `.env` settings. Both `--flag VALUE`
and `--flag=VALUE` work; repeated flags apply in order, with the last value
winning. Relative source paths resolve against this repository. Passwords and
tool-version overrides remain environment settings, listed in `--help`.

Put Docker Compose `up` options and service names **after `--`**:

```bash
./start.sh --port 8090 -- --wait --timeout 60
```

Help exits before creating directories or calling Docker. Invalid launcher
arguments fail before startup.

### Proxy

For a proxy listening on the host at `127.0.0.1:7890`:

```bash
./start.sh --proxy http://127.0.0.1:7890 --no-proxy localhost,127.0.0.1,::1
```

The workspace uses host networking, so the container can reach a proxy on the
host's loopback address. The same proxy flags apply to source-build commands.
Docker/BuildKit image pulls use Docker/BuildKit's own proxy configuration.

Existing environment settings also work:

- HTTP: `OPENCODE_HTTP_PROXY` → `HTTP_PROXY` → `http_proxy`.
- HTTPS: `OPENCODE_HTTPS_PROXY` → `HTTPS_PROXY` → `https_proxy`.
- `ALL_PROXY` and `NO_PROXY` fall back to their lowercase forms.

The first set variable wins, including an explicit empty value. Use
`--http-proxy=` to clear one proxy or `--disable-proxy` to clear all of them.
`--no-proxy` specifies bypass hosts; it does not disable the proxy globally.

### Address and Port

```bash
./start.sh --bind 127.0.0.1 --port 8090
```

Then open <http://127.0.0.1:8090>. Use `--bind 0.0.0.0` for access from other
devices at `http://<host-ip>:8090`. Environment equivalents are
`OPENCODE_BIND_ADDRESS` and `OPENCODE_PORT`.

### Shared Configuration and Skills

The launcher uses `$HOME/.config/opencode` when present, otherwise
[`config/opencode/`](config/opencode/). Choose your own sources with:

```bash
./start.sh --config-source '/path/to/shared config' --skills-source /path/to/skills
```

Sources are mounted read-only. On each container start, configuration is copied
into a writable per-instance volume so plugins can install dependencies there.
Source edits and deletions take effect after restarting the container:

```bash
docker compose restart opencode
```

### OpenCode Version and Upgrades

`OPENCODE_VERSION` selects an exact stable V2 release (currently `2.3.2`).
The first `opencode` invocation installs that version using the official Bun
package and its platform-selecting postinstall script. Installs live in the
`opencode-data` volume under `$XDG_DATA_HOME/opencode/runtime/v1/`, keyed by
platform/CPU variant and version. Normal restarts verify and reuse the exact
cached binary without contacting the installer or network. OpenCode itself and
configured plugins/providers may still use the network.

Upgrade without rebuilding the runtime image:

```bash
OPENCODE_VERSION=2.3.2 ./start.sh --no-pull
# Or set OPENCODE_VERSION in .env, then:
docker compose up -d --pull never
```

Replace the example pin with the desired published stable V2 release. Compose
recreates the service when its version environment changes. `docker compose
restart` keeps the existing environment and does not reread `.env`. Shell
overrides win over `.env`; the launcher otherwise uses `versions.env`, and
direct image/Compose use falls back to the default pin baked into the image.
Each uncached version requires network access; failed installs stop that launch
with an error and never fall back to another version. Switching back to a cached
pin reuses it. Old versions remain until the operator removes their cache entries
while the service is stopped; deleting `opencode-data` also deletes sessions and
authentication, so retain that volume.

The launcher serializes installation with `flock`, verifies the native version,
and atomically publishes a staged binary plus version/platform/SHA-256 marker.
Warm launches check the marker and checksum. This is an integrity check within
trusted, runtime-user-owned storage, not a security boundary against that user.
Interrupted stages are never cache hits. Arbitrary downstream commands such as
`Rscript` install nothing unless they invoke `opencode` themselves.

### Personal Workspace Preferences

Use the root `opencode.jsonc` for local OpenCode preferences. On a fresh checkout,
create it from the tracked template (keep your existing file if you have one):

```bash
cp opencode.example.jsonc opencode.jsonc
```

Uncomment `model` or `default_agent` in the template as needed, choosing a model
available in your instance. Both root `opencode.jsonc` and `opencode.json` are
Git-ignored and excluded from image builds; `opencode.example.jsonc` is shared.

OpenCode merges these settings natively. Ordinary settings apply in this order,
from lower to higher precedence: shared global configuration → chat profile
(`OPENCODE_CONFIG`) → discovered project configuration. The root file applies
to this workspace and its descendants, including projects opened beneath it.
Closer direct project configs override ancestor direct configs; discovered
`.opencode/opencode.json(c)` files are then applied with higher precedence than
all direct configs. Managed settings and policies have their own precedence
rules; see the [V2 config guide](https://opencode.ai/v2/docs/config).

The workspace root is already bind-mounted at `/home/bun/workspace`. Edits to
this local config reload natively after saving, without a container restart;
use `/reload` to force a full reload. Shared source configuration still follows
the copy-on-start workflow above.

### Git Commit Identity

The launcher reads the host's global Git identity and passes it into the
container:

```bash
git config --global user.name 'Your Name'
git config --global user.email 'you@example.com'
./start.sh
```

Git resolves both `~/.gitconfig` and XDG configuration paths. When using
`docker compose up` directly, supply `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
`GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` yourself.

## Chat Agents and Memory

Switch agents in the OpenCode interface:

| Agent | Use case | Memory |
| --- | --- | --- |
| `serious` (default) | Calm, direct discussion and tasks needing follow-up | Reads and writes shared memory in `.sessions/MEMORY.md` and `.sessions/` |
| `casual` | Relaxed, familiar conversation with light humor | May read shared memory; writes privately in `.sessions/casual/` by default |
| `temp` | One-off questions and temporary conversations | Workspace memory and file/command tools are disabled |
| `build` (built-in) | Coding and implementation | Reads and writes shared memory only |
| `plan` (built-in) | Research and planning | Reads shared memory only; never records or updates it |

- `serious`, `casual`, `build`, and `plan` review available memory when a session starts.
  When a topic concludes, `serious`, `casual`, and `build` save a record and retain useful enduring information.
  Say **“do not record”** to skip memory updates for that topic.
- Ask `casual` explicitly to share information if it should enter shared memory.
  `serious`, `build`, and `plan` do not access the private `casual` directory.
- Switching agents preserves the current conversation. Start a **new session**
  before switching to `temp` to isolate earlier context, or from `casual` to
  `serious`, `build`, or `plan` when private content needs to remain isolated.
- `temp` disables workspace memory recording; OpenCode's own session
  persistence still applies.

Agent definitions live in [`config/chat/`](config/chat/); memory procedures
are in [`AGENTS.md`](AGENTS.md). These chat agents are loaded by this workspace.
The reusable runtime provides neutral development defaults.

### Memory Tools

The chat profile includes a local, dependency-free OpenCode V2 plugin at
[`config/chat/memory-plugin/`](config/chat/memory-plugin/). It stores Markdown
documents and their YAML metadata in SQLite and provides six tools:

| Tool | Purpose |
| --- | --- |
| `memory_recall` | Read summary/navigation, available section titles, and five recent index entries |
| `memory_search` | Find matching records with short snippets |
| `memory_read` | Read a record or memory file, optionally selecting an exact heading title with `section` |
| `memory_record` | Save a topic record and update its index together |
| `memory_update` | Edit long-term memory or an existing session record with a revision check |
| `memory_delete` | Delete an existing session record with a revision check (SQLite v2 only) |

The host supplies the current agent identity. `serious` and `build` use shared memory;
`casual` can read both spaces and writes privately by default. Explicit shared
writes use `scope: "shared", share: true`. Delete only at the user's explicit
request; OpenCode asks for permission in writable modes. `plan` has read-only
shared access, enforced by the store for all writes. `temp`, `general`,
and `explore` have no memory-tool access. Native V2 permission overrides enable
`build` and `plan` while preserving their built-in coding prompts. `AGENTS.md`
defines startup and task-conclusion procedures, including shared-only fallbacks
and the prohibition on `plan` writing memory through CLI commands or file edits.
The model still decides when and what to record, following your instructions;
the plugin does not automatically collect conversations or call another model.

Existing Markdown records are available after an explicit import. Stable IDs
stay with records across edits and synchronization. `INDEX.md` and recent records
in recall are derived from the current records.
Search matches all whitespace-separated literal terms,
case-insensitively, including Chinese text. Results are bounded; long reads can
be paged. Writes use SQLite transactions; stale revisions are rejected. New
record names include a UTC date and a stable tool-call suffix.

Restart the container once after updating the chat profile to copy the plugin
into its writable configuration mirror. Its configured memory root is
`/home/bun/workspace`; adjust the plugin's `options.root` in
`config/chat/opencode.jsonc` for another workspace layout. The plugin is loaded
only through the chat profile, and the agents retain a scoped SQLite CLI fallback.
See [Memory format and migration](#memory-format-and-migration) for the file
schema, migration command, and backups.
Other shell-capable harnesses can use the [standalone memory CLI](#using-memory-from-other-harnesses).

Agent-level tool restrictions organize memory access; ordinary filesystem
access remains controlled separately by OpenCode permissions and mounts.

## Workspace, Mounts, and Data

### Projects and Read-Only Reference Directories

This repository is mounted at `/home/bun/workspace`. The launcher creates
`projects/` for development; it is Git-ignored and excluded from image builds.

To mount existing host projects or reference material, copy the override example:

```bash
cp compose.override.example.yaml compose.override.yaml
```

For each mount, use an existing absolute host `source` and a distinct container
`target` under `/home/bun/workspace/projects/<name>`:

- `read_only: false` allows the agent to edit the project.
- `read_only: true` provides reference access while protecting the host files
  from writes through that mount.

The launcher loads `compose.override.yaml` for both ordinary startup and source
builds. Configuration and skills are also mounted read-only.

### Persistent Data and Host Credentials

Each Compose project has its own volumes:

| Volume | Contents |
| --- | --- |
| `opencode-config` | Writable configuration mirror and plugin dependencies |
| `opencode-data` | Authentication and session state |
| `opencode-cache` | Tool caches |

You can sign in through the interface. To seed existing host credentials instead,
add this read-only directory mount to `compose.override.yaml`:

```yaml
services:
  opencode:
    volumes:
      - type: bind
        source: ${HOME}/.local/share/opencode
        target: /opt/opencode-auth-source
        read_only: true
        bind:
          create_host_path: false
```

The entrypoint imports `auth.json` and `account.json` only when the instance
copies are absent. Token refreshes are saved in instance state; the host source
stays unchanged.

### Shell Access

The service runs as the host UID/GID, keeping mounted files under the expected
ownership. Pass that user explicitly to `docker compose exec`, whose default
user is root:

```bash
docker compose exec -u "$(id -u):$(id -g)" opencode sh
docker compose exec -u "$(id -u):$(id -g)" opencode opencode
```

## Developer Guide

The source-built runtime uses Ubuntu 24.04 with OpenCode, Bun, uv, fish,
ripgrep, and common shell tools. Node, Rust, and C/C++ toolchains are optional
project extensions.

- [Build from source](#building-from-source)
- [Reuse in another project](#using-the-runtime-in-another-project)
- [Add toolchains](#adding-project-toolchains)
- [Configuration and entrypoint internals](#configuration-and-entrypoint-internals)
- [Run checks](#focused-checks)
- [Publish a release](#publishing-the-runtime)

### Building From Source

Local builds require Buildx and Compose support for `build.entitlements` and
`docker compose build --print`.

```bash
./start.sh --build
# With a host proxy:
./start.sh --proxy http://127.0.0.1:7890 --build
```

This builds `ghcr.io/hoshinokoji/opencode-runtime:local` and starts it after a
successful build. Use `--image` to choose another tag. Put the launcher's
`--build` before any `--` separator. Build startup always uses `--no-build
--pull never`, regardless of launcher pull flags, so it runs the loaded local
result. BuildKit may still download pinned build dependencies.

#### Tool Versions

[`versions.env`](versions.env) is the single source of truth for local builds
and publishing. Explicit environment overrides win; there is no implicit
`latest` fallback.

| Tool | Version |
| --- | --- |
| Bun | `1.4.4` |
| uv | `0.13.8` |
| OpenCode | `2.3.2` |

For example, to build with a different pinned Bun version:

```bash
BUN_VERSION=1.3.15 ./start.sh --build
```

Bun and uv come from version-pinned official images. Builds bake the OpenCode
default pin and a launcher at `/usr/local/bin/opencode`; they download no OpenCode
package. At runtime the launcher uses `bun install -g --trust
@opencode/cli@<version>` in an isolated staging directory, retaining the selected
native binary in the data volume. The native CLI does not require Node. The
entrypoint prepares state and drops to the configured UID/GID before installation;
custom `OPENCODE_HOME` layouts use the corresponding data-volume target.

When upgrading from V1, back up persistent configuration and data volumes.
Check custom plugins and providers against the
[V2 documentation](https://opencode.ai/v2/docs/); image smoke checks do not
validate every existing session migration or host configuration.

#### Build Networking and Compose Compatibility

The launcher exports the resolved Bake definition with
`docker compose build --print`, then runs Buildx with `--allow=network.host`,
repository-scoped `fs.read`, and `--load`. It then starts Compose with
`--no-build --pull never`. Compose resolves version pins, proxy arguments, and overrides.

This works around Compose v5.6.0's missing host-network grant forwarding.
That release does not read `COMPOSE_BAKE`; declaring `build.entitlements`
alone does not fix `additional privileges requested: pass "--allow=network.host"`.
The `--allow` option belongs to Buildx, not `start.sh`.

Build steps can reach the builder host's network, including loopback proxies.
Use trusted build inputs. External build contexts require an additional scoped
filesystem grant. A custom BuildKit daemon must also permit `network.host`.

#### Build Without Starting

Run from the repository root:

```bash
set -a; . ./versions.env; set +a
export OPENCODE_IMAGE=${OPENCODE_IMAGE:-ghcr.io/hoshinokoji/opencode-runtime:local}
(
  set -eu
  bake_file=$(mktemp)
  trap 'rm -f "$bake_file"' EXIT
  docker compose -f compose.yaml -f compose.build.yaml build --print opencode > "$bake_file"
  docker buildx bake --file "$bake_file" --allow=network.host \
    --allow="fs.read=$PWD" --load opencode
)
```

Add `-f compose.override.yaml` to the Compose command when using local
overrides. `start.sh --build` includes that file automatically.

### Using the Runtime in Another Project

An extension image starts `FROM ghcr.io/hoshinokoji/opencode-runtime:<version>`
and adds its project tools. A project service inherits the shared runtime
fragment through Compose `extends`:

```yaml
services:
  my-service:
    extends:
      file: ${OPENCODE_DOCKER_ROOT:-../opencode-docker}/compose.runtime.yaml
      service: opencode-runtime
    image: my-project:local
    working_dir: /home/bun/project
    volumes:
      - type: bind
        source: .
        target: /home/bun/project
      - type: bind
        source: /absolute/host/opencode-config
        target: /opt/opencode-config-source
        read_only: true
      - type: bind
        source: /absolute/host/claude-skills
        target: /opt/claude-skills
        read_only: true
    ports:
      - "4096:4096"

# extends does not import top-level resources.
volumes:
  opencode-config:
  opencode-data:
  opencode-cache:
```

Set `OPENCODE_DOCKER_ROOT` to this repository's checkout. Use `extends` to
merge the service; `include` does not provide the same merge behavior.
Declare the named volumes and bind sources in the consuming project.

The fragment centralizes UID/GID handling, Git identity, proxies, and writable
state. It reads `OPENCODE_IMAGE`, `OPENCODE_UID`, `OPENCODE_GID`,
`OPENCODE_WORKING_DIR`, and `OPENCODE_PORT` from the environment. Set
`OPENCODE_HOME` in the host environment or project `.env` before Compose
interpolation so environment and volume targets agree. This example uses bridge
networking; the personal chat workspace chooses host networking.

### Adding Project Toolchains

Copy an example into the downstream project as `Dockerfile`:

- [`examples/node.Dockerfile`](examples/node.Dockerfile): Node, npm, and npx.
- [`examples/cpp.Dockerfile`](examples/cpp.Dockerfile): C/C++ and pkg-config.
- [`examples/rust.Dockerfile`](examples/rust.Dockerfile): Rust and the C/C++ linker toolchain.

The examples default to the locally built slim runtime. After a slim release,
pin `RUNTIME_IMAGE` to its published tag. Add this build configuration to the
service above:

```yaml
services:
  my-service:
    build:
      context: .
      args:
        RUNTIME_IMAGE: ghcr.io/hoshinokoji/opencode-runtime:local
    image: my-project:local
```

Run `docker compose up -d --build`. Installed tools remain in the project image
across container recreation.

For Python, `uv sync` prepares the project environment and `uv python install`
installs managed Python. Persist `$XDG_DATA_HOME/uv` in a project volume if
managed Python should survive recreation. `uvx` and `bunx` run temporary tools;
required system libraries and runtimes must still be present.

For Rust, optionally mount a named volume at `/home/bun/.cargo` (adjust for a
custom `OPENCODE_HOME`) to persist registries and installed binaries. The
entrypoint prepares a writable `CARGO_HOME`. Existing `opencode-cargo` volumes
are retained by Docker during upgrades and can be mounted explicitly.

### Configuration and Entrypoint Internals

- `/opt/opencode-config-source` is mirrored into the instance's writable
  configuration directory on every start. Generated dependencies are excluded
  from the source copy and retained in the destination. Source deletions remove
  stale mirrored entries; instances do not share `node_modules`.
- The chat workspace mounts [`config/chat/`](config/chat/) at
  `/opt/opencode-profile-source`. Its agents are installed into the instance
  configuration and its JSONC is loaded through `OPENCODE_CONFIG`, after global
  preferences and before project settings.
- Without a source mount, the entrypoint seeds the baked neutral defaults from
  [`config/opencode/`](config/opencode/). Shared skills live in
  [`config/skills/`](config/skills/) and are mounted at `/opt/claude-skills`.
- The entrypoint aligns HOME/XDG paths, owns runtime-managed directories, drops
  root to `OPENCODE_UID:OPENCODE_GID`, and executes the requested command
  unchanged. Extension commands such as `docker run <image> Rscript script.R`
  work normally.
- Plain `docker run` without an explicit server password uses OpenCode V2's
  generated password, printed as `server password ...`; it changes on server
  restart. The personal workspace supplies its own Compose default.

### Memory Format and Migration

Recall uses summary/navigation for long-term memory, with one short-file exception:
without a summary heading, a body of at most 2000 characters is returned in full
(`mode: full`). Otherwise `mode: overview` applies; long files with no summary
report that explicitly and provide section navigation. A short memory therefore
needs no redundant summary. This rule is shared by the plugin, CLI, and MCP.

Memory uses Markdown with YAML frontmatter, parsed with Bun's built-in YAML
support. For example:

```markdown
---
schema_version: 1
id: "record-unique-stable-id"
type: "session"
date: "2026-11-14"
topic: "memory-storage"
summary: "Use Markdown and YAML metadata for portable memory."
created_at: "2026-11-14T13:00:00.000Z"
updated_at: "2026-11-14T13:00:00.000Z"
---
# Memory storage

## Details
Discussion, decisions, and follow-up remain ordinary Markdown.
```

`type` is `session` for records or `long_term` for `MEMORY.md`. The fields shown
are required; optional `preferences` contributes to the generated index. Other
custom metadata is preserved during updates. Quote dates and
timestamps as strings, and preserve `id` when editing or moving a record.
Shared/private scope comes from the database (or import directory) rather than a YAML field.
Duplicate session IDs within one space are reported as sync conflicts.

Tool reads return `metadata` separately from the paginated Markdown body.
`memory_update` accepts the body only and preserves metadata, including the
stored session summary shown in recall and the index, except `updated_at`.
Revisions cover the complete stored raw document, including metadata.

#### Historical Markdown maintenance utilities

The following subsection describes the retained offline `manage.js` utility and
internal Markdown fixtures only. Runtime plugin/CLI/MCP exclusively use SQLite;
they never perform these relocations or read Markdown fallback files. For runtime
migration use `memory.sh import` below, which leaves the source unchanged.
These older commands edit source Markdown and are unnecessary for SQLite import.

Run these only against an explicitly chosen offline legacy copy:

```bash
# Preview; does not change memory or create backups.
bun config/chat/memory-plugin/manage.js migrate --root /absolute/offline-copy --scope shared --dry-run

# Back up and migrate shared and private files, preserving bodies and filenames.
bun config/chat/memory-plugin/manage.js migrate --root /absolute/offline-copy --scope shared

# Recreate derived indexes after file synchronization or manual metadata edits.
bun config/chat/memory-plugin/manage.js reindex --root /absolute/offline-copy --scope shared

# Preview and then relocate only shared root MEMORY.md, preserving every byte.
bun config/chat/memory-plugin/manage.js relocate-shared --root /absolute/offline-copy --dry-run
bun config/chat/memory-plugin/manage.js relocate-shared --root /absolute/offline-copy
```

The `migrate` and `reindex` commands accept `--root DIR` and `--scope shared|private|both` (default:
current directory, both spaces). Migration is repeatable: files that already
have supported frontmatter are left untouched. It validates all selected files
before writing. Legacy files without frontmatter remain readable, searchable,
and indexable throughout the transition. Empty placeholder files are reported
under `skippedEmpty` and left untouched; they are excluded from generated indexes.

Shared long-term memory lives at `.sessions/MEMORY.md`. Read tools fall back to
root `MEMORY.md` for older workspaces; their logical filename remains `MEMORY.md`.
`relocate-shared` accepts `--root DIR`, optional `--scope shared`, and `--dry-run`;
it touches only shared long-term memory. Preview creates no files or lock.
Execution holds the store lock, backs up the original with a SHA-256 manifest,
creates the destination exclusively, verifies full bytes, then removes the root
original. Repeating it is a no-op. IDs, metadata, body and revision are preserved.
Long-term updates perform the same backed-up relocation after revision validation;
the `migrate` metadata command retains each file's current physical path.
If both paths exist (even identical files or empty placeholders), reads, updates,
and migrations report a conflict. Back up and reconcile them explicitly. An
interrupted relocation can leave both paths plus its backup; resolve that conflict
before retrying. Coordinate external editors/sync clients while relocating:
the local lock coordinates store writers only.

Each migration with changes first backs up original documents and indexes to
`.sessions/.backups/<batch>/` and `.sessions/casual/.backups/<batch>/`, keeping
private backups in the private space. Each backup's `manifest.json` records the
original relative paths and SHA-256 checksums. To restore, stop memory writers
and copy originals to those paths. Older backups and relocation backups name root
`MEMORY.md`; newer canonical backups name `.sessions/MEMORY.md`. When restoring a
root backup after relocation, first back up and remove the canonical counterpart
to avoid a dual-path conflict, then optionally run `relocate-shared` again.
Backups are excluded from memory searches, Git, and image builds.

Migration adds metadata without rewriting the existing body, including its old
summary section. Session summaries/preferences are extracted from the English
or Chinese template fields, with the title as a summary fallback. Legacy
session timestamps use midnight UTC on the filename date and are marked
`timestamp_source: legacy-date`; long-term files use their original modification
time, marked `legacy-file-mtime`. These are migration approximations, not newly
discovered historical creation times.

For an offline legacy Markdown copy, the source files are `.sessions/MEMORY.md`,
`.sessions/casual/MEMORY.md`, and the dated Markdown records in both spaces. Indexes are disposable derived data.
Keep a backup copy separately if desired. Simultaneous edits to the same file
still require normal sync-conflict resolution; local locks do not coordinate
machines.

### Local SQLite Memory

SQLite is the sole runtime backend for plugin, CLI and MCP tools; selecting
`markdown` fails explicitly. SQLite requires an **explicit absolute memory
root**, which can be shared by calls from different worktrees:

```bash
mkdir -p /absolute/persistent/memory
export MEMORY_ROOT=/absolute/persistent/memory
./memory.sh init --root "$MEMORY_ROOT" --space shared
./memory.sh recall
./memory.sh search '中文 preference' --space shared
./memory-mcp.sh --backend sqlite --root "$MEMORY_ROOT" --read-only
```

CLI/MCP `--backend` overrides `MEMORY_BACKEND`; only `sqlite` is accepted. For the OpenCode plugin, set
`options: { "backend": "sqlite", "root": "/absolute/persistent/memory" }` on its
existing plugin entry; plugin options override the environment. In containers,
mount that directory persistently and use its **container** absolute path. Mount
the directory so SQLite can write WAL/SHM sidecars alongside the database.

SQLite stores plaintext in `.memory-db/shared.sqlite` and
`.memory-db/private.sqlite` under that root, creating each only on its first
write. It preserves tool scope permissions, stable IDs, metadata, pagination,
section updates, retry behavior and full-document revisions. INDEX remains
derived. Record results return `logicalPath` (for example `.sessions/2026-01-01-topic.md`)
and `name` (the `.md` logical document name); the Markdown body lives in SQLite.
The former record-result `path` key has been removed. Administrative `databasePath`
and `backupPath` identify actual SQLite files; import/export source/destination and
legacy backup-manifest `path` fields remain physical paths.
Reads of a missing SQLite space return empty memory without importing any
Markdown files. `init` is idempotent and initializes only selected spaces. For
ergonomics, ordinary writes may also initialize an empty space; initialization
never imports existing Markdown. Reads of absent spaces create no databases.

#### Explicit initialization, import and rollback export

```bash
# Source and destination are existing absolute directories; --root is the database destination.
./memory.sh import --source /absolute/old-workspace --root "$MEMORY_ROOT" --space shared --dry-run
./memory.sh import --source /absolute/old-workspace --root "$MEMORY_ROOT" --space shared
# migrate is an alias for import. Select private or both only when authorized.
# Export requires a new destination whose parent already exists.
./memory.sh export --root "$MEMORY_ROOT" --destination /absolute/backups/new-export --space shared --dry-run
./memory.sh export --root "$MEMORY_ROOT" --destination /absolute/backups/new-export --space shared
```

`init`, `import`/`migrate` and `export` support `--dry-run` and explicit
`--space shared|private|both` (default shared). They are CLI administration
commands, never agent or MCP tools. Caller permissions and recording consent
still apply. Stop source Markdown writers/editors during import; import reads a
snapshot into memory and leaves all source files untouched. Back up sources separately.
It accepts shared `.sessions/MEMORY.md` or legacy root `MEMORY.md`, dated records
in `.sessions/`, and private documents in `.sessions/casual/`. Dual shared paths
are rejected even if identical or empty. INDEX is derived; old INDEX files and
`.backups/` contents are excluded. Unexpected filenames, selected symlinks,
duplicate IDs, invalid metadata/UTF-8, and differing destination documents fail.
Exact matching imports are idempotent. Raw UTF-8 bytes, existing metadata and IDs
are preserved, including CRLF/BOM and legacy documents without frontmatter.

All selected spaces are preflighted before writing, then each space commits in
one transaction with history/outbox. A failure within a space rolls it back;
`both` is two independent transactions, so a late failure in private can leave
shared committed. Retry safely after resolving the error. There is no cross-space
atomicity or live-source snapshot guarantee. Shared-only commands never open
private documents or databases.

Export writes current raw documents into canonical Markdown paths in a new
directory; it omits derived indexes and database history. Use that snapshot with
a legacy Markdown reader for rollback, or import it into a fresh SQLite root.
Preserve database history with a separate consistent SQLite backup (stop writers
before copying database files and their WAL sidecars).

#### Opt-in local sync-state integration (schema v2)

Plugin/CLI/MCP support both v1 and v2. New databases initialize as v1 and ordinary
reads/writes never upgrade them. After an explicit upgrade, records, updates,
deletions and imports atomically persist sync operations, branch snapshots, stable section
IDs, projections and the sync outbox. Runtime reads and exports use the current
projection, including received changes and tombstones. Existing v1 history and
pending outbox entries are retained. Runtime edits use conservative whole-document
operations; heading IDs survive unchanged outlines, while structural rewrites
start a new identity epoch. Section updates still preserve sibling text and metadata.

First install this version for **every writer** and stop all writers, including
already-loaded old plugins and MCP servers. Then, for each authorized space:

```bash
./memory.sh sync-status --root "$MEMORY_ROOT" --space shared
./memory.sh upgrade-sync --root "$MEMORY_ROOT" --space shared --dry-run
./memory.sh upgrade-sync --root "$MEMORY_ROOT" --space shared
```

The upgrade validates an in-memory copy, then takes a write lock, creates and fsyncs
a standalone v1 backup, and migrates transactionally. Save its returned `backupPath`.
These commands select one space at a time; they are CLI administration, outside
agent/MCP tools. Restart only updated writers after upgrade. Old runtime code
rejects v2; stopping writers prevents an already-open old connection from writing
the old tables after migration. See [upgrade, rollback and limitations](docs/memory-sync-milestone.md).

This is local write integration plus an embedded synthetic relay engine. Conflict
resolution/restoration, operator bootstrap/sync commands, Cloudflare transport,
encryption and a general backup/restore CLI remain deferred. Conflicted/tombstoned
documents block ordinary writes; inspect `sync-status` and retain the database.
Local storage and sync execution are trusted plaintext; optional encryption
belongs at upload/download boundaries.
See also [runtime architecture and references](docs/memory-sqlite-milestone.md).
Keep database directories and any future sync credentials/keys or exports in the
ignored `.memory-db/`, `.memory-sync/` and `.memory-exports/` locations.

### Using Memory From Other Harnesses

[`memory.sh`](memory.sh) bridges the same store to any harness that can execute
shell commands. It needs Bun with YAML support and this checkout; it does not
need a running OpenCode server, Docker, or model credentials.

Set the executable and memory workspace paths in the harness environment:

```bash
export MEMORY_CLI=/absolute/path/to/opencode-docker/memory.sh
export MEMORY_ROOT=/absolute/path/to/memory-workspace

"$MEMORY_CLI" --help
"$MEMORY_CLI" recall
"$MEMORY_CLI" search "container isolation"
"$MEMORY_CLI" read MEMORY.md --offset 0 --limit 12000
```

`--root DIR` overrides `MEMORY_ROOT`; one must provide an absolute directory.
Input file paths are relative to the caller's working
directory. The default space is **shared**. Use `--space private` for private
memory or `--space both` to read both spaces; writes select one space at a time.
These are caller-selected spaces, not authenticated agent identities. Other
harnesses apply their own permissions and temporary/no-memory policies.

For a topic record, save a JSON input file (or pipe it to `--input -`):

```json
{
  "topic": "memory-bridge",
  "goal": "Reuse workspace memory in another harness",
  "conclusion": "Use the standalone CLI",
  "details": "Markdown discussion, decisions, and follow-up."
}
```

```bash
"$MEMORY_CLI" record --input record.json --request-id unique-session-topic-id
```

Optional string fields are `decisions`, `nextSteps`, and `preferences`. Use a
unique request ID per record and reuse it on retries; the store finds an existing
record even after a filename/date change. Without `--request-id`, the CLI
generates one and returns it as `requestId`. JSON cannot override the space.

For whole-file updates, read the entire target body first, merge changes, and submit
this JSON. Omit `name` for `MEMORY.md`; include it to select an existing session
record. Editing works in SQLite v1 and v2:

```json
{
  "name": "2026-01-01-topic.md",
  "content": "# Topic\nComplete merged Markdown body, without YAML frontmatter",
  "expectedRevision": "revision returned by read"
}
```

```bash
"$MEMORY_CLI" update --input update.json
```

To edit only one section, first read every page of that section and include
`section` in the update JSON (also supported by plugin and MCP tools):

```json
{
  "section": "交流风格与记忆维护偏好",
  "content": "## 交流风格与记忆维护偏好\n\nMerged section content, including any nested subsections.",
  "expectedRevision": "full-file revision returned by the section read"
}
```

The exact title must identify one existing section. Keep its heading title and
level; only lower-level nested headings may follow it, and code fences must be
closed. All content outside the selected section stays byte-for-byte unchanged.
The full-file revision still detects edits elsewhere; reread and merge on conflict.
Metadata and stable ID are preserved. Update affected summary/navigation sections
separately using the latest revision so the overview stays consistent. Whole-file
updates remain available for renaming headings or restructuring several topics.

To delete an existing session record, read it to get the current revision and
run `"$MEMORY_CLI" delete --input delete.json`. The JSON contains `name` and
`expectedRevision`; choose the same `--space` used to read the record. Only
upgraded SQLite v2 spaces support deletion. `MEMORY.md` and `INDEX.md` are protected.
Deleted records disappear from search, recall, indexes and Markdown exports; a
direct whole-body read has the same empty result as a missing record. SQLite
retains the tombstone and history, so this is not secure erasure. A repeat
delete, a `record` retry with the deleted identity, or an import matching the
tombstoned name or ID fails. An old `record` retry cannot overwrite an edit
and fails if its content no longer matches. Markdown exports do not carry
tombstones or history to a fresh database.

Success returns one JSON object on stdout and exits 0. Usage/JSON validation
errors return JSON on stderr and exit 2; filesystem/store errors exit 1.
Read conflicts require another read and merge. CLI and plugin calls share the
same file locks, revisions, metadata, and index logic.

The portable [workspace-memory skill](config/chat/memory-plugin/skill/SKILL.md)
can be copied into another harness's skill directory or adapted as its project
instructions. Configure `MEMORY_CLI` and `MEMORY_ROOT` alongside it. It describes
when to recall/record, how to page reads, and how to preserve user recording
preferences. The skill is opt-in and is not added to neutral runtime defaults.

### Antigravity and Other MCP Clients

[`memory-mcp.sh`](memory-mcp.sh) exposes the same `MemoryStore` as a local stdio
MCP server. Install its separate, pinned dependencies once from this checkout:

```bash
bun install --cwd config/chat/memory-mcp --frozen-lockfile
./memory-mcp.sh --help
```

The bridge requires Bun with built-in YAML support on the **client's machine**,
and a locally accessible checkout and memory directory. Bun must be on the MCP
client process's `PATH`. The launcher never installs dependencies or accesses the
network at startup. Its package and lockfile are isolated under
`config/chat/memory-mcp/`; the OpenCode plugin keeps its dependency-free runtime.

In Antigravity IDE, open **… → MCP Servers → Manage MCP Servers → View raw
config**, and merge this entry into `mcpServers` (replace the absolute paths):

```json
{
  "mcpServers": {
    "workspace-memory": {
      "command": "/absolute/path/to/opencode-docker/memory-mcp.sh",
      "args": ["--space", "shared"],
      "env": {
        "MEMORY_ROOT": "/absolute/path/to/memory-workspace"
      }
    }
  }
}
```

The current official Antigravity docs list `~/.gemini/config/mcp_config.json`
for global configuration and `.agents/mcp_config.json` for workspace
configuration. The App exposes its config location through **Customizations →
Installed → MCP Servers → Copy Config File Path**. Reload/restart the server
through the client's MCP manager after changing startup policy. This integration
is tested with the official SDK client over stdio. The workspace user also
reported testing the Antigravity integration successfully in November 2026.

Policy is fixed when the process starts:

| Startup option | Reads | Writes |
| --- | --- | --- |
| Default / `--space shared` | Shared only | Shared only |
| `--space private` | Private only | Private only |
| `--space both` | Both by default; optional narrower `scope` | Explicit `scope: "shared"` or `"private"` required |
| `--read-only` | Within configured space | Hidden from tool discovery and denied |

`--root DIR` takes precedence over `MEMORY_ROOT`, as with the CLI. The MCP
bridge requires one of these explicitly to avoid using an IDE's unexpected
working directory; the directory must already exist. Relative roots resolve
against the client-selected working directory. `--root=DIR` and `--space=VALUE`
also work. Unknown flags and positional arguments fail with exit 2.

Tools are `memory_recall`, `memory_search`, `memory_read`, `memory_record`,
`memory_update`, and `memory_delete`. Arguments use the CLI's JSON field names
plus optional `scope`.
`memory_record` **requires `requestId`**: choose a unique, non-secret ID before
the first call and reuse it with identical content on retries, including lost
responses. `memory_read` accepts `name`, optional `section`, `offset`, and `limit` (up to 20000
characters), returning `total`, `truncated`, metadata, and `revision` separately.
`section` selects an exact ATX heading title without `#` markers, includes its
heading and nested sections, and ends at the next same/higher-level heading.
Fenced code headings are ignored; missing or duplicate titles produce explicit
errors. Pagination (`offset`, `total`, `truncated`) is relative to that selection;
metadata and revision still cover the full file. Session records also support
sections; INDEX.md supports only whole-body pagination. The CLI equivalent is
`memory.sh read MEMORY.md --section "速览摘要" --offset 0 --limit 2000`.
For whole-file `memory_update`, omit `section` and read every whole-body page; send the complete merged body as
`content` and its `expectedRevision`. Omit `name` for `MEMORY.md` or give an
existing session filename. If a revision changes during paging or update, read
again and merge. With the user's explicit authorization, `memory_delete` takes
an existing session filename and current `expectedRevision` in a v2 space.
Search takes `query` and optional `limit` (1–20),
returning total matches and a bounded result list. Recall returns five recent
entries per space plus summary/navigation only, with section title/level
descriptors for targeted loading. Recognized summary titles are `速览摘要`, `摘要`,
`Summary`, and `Quick summary`; navigation titles are `内部导航与按需提取索引`,
`内部索引`, `Navigation`, and `Index` (exact, case-sensitive). Missing summaries
are reported explicitly, with guidance to read MEMORY.md. Recall text is capped
at 10000 characters and descriptors at 100 (`sectionsTotal`/`sectionsTruncated`
report overflow); page summary/navigation using their section titles or use a
whole-body read to discover further headings. Tool results include JSON text and `structuredContent`;
operation errors set `isError`. Stdout carries only MCP messages; startup errors
and help go to stderr.

External MCP has **no harness-agent authentication**. The startup options define
the allowed access for every client connected to that process; a tool argument
cannot broaden it. The adapter uses the store's file locks, revisions, metadata,
symlink checks, and generated indexes without supplying an OpenCode agent
identity. Each harness must still enforce its own plan/read-only, temp/no-memory,
and user recording-consent rules. Configure `--read-only` for read-only contexts;
disable the server entirely in no-memory contexts. Client-side tool hiding alone
does not enforce read-only access. Direct filesystem access is governed by the
host's own permissions.

Official references (checked November 2026):
- [Antigravity custom MCP setup and stdio configuration](https://antigravity.google/docs/mcp)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/),
  [stdio server](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html), and
  [client connection](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect.html)
- Pinned official packages: [server 2.4.0](https://registry.npmjs.org/@modelcontextprotocol/server/2.4.0)
  and [client 2.4.0](https://registry.npmjs.org/@modelcontextprotocol/client/2.4.0).
  The older `@modelcontextprotocol/sdk` package is the v1 maintenance line.

### Focused Checks

Run the daemon-free version-smoke, configuration-mirror, and launcher checks:

```bash
uv run --no-project --with pytest pytest tests -q
bun test tests/memory-plugin.test.js tests/memory-cli.test.js tests/memory-sqlite.test.js tests/memory-transfer.test.js tests/memory-sync.test.js
bun install --cwd config/chat/memory-mcp --frozen-lockfile
bun test ./config/chat/memory-mcp/server.test.js
sh -n start.sh
sh -n memory.sh
sh -n memory-mcp.sh
sh -n docker/entrypoint.sh
sh -n docker/smoke-tools.sh
```

The Python suite also loads the chat memory plugin in an isolated real server
when `opencode` is installed; that integration check is skipped otherwise.
The MCP suite starts real stdio child processes and uses the official client for
initialization, tool discovery/calls, scope isolation, read-only enforcement,
strict inputs, pagination, revision conflicts, and stable retry IDs. Its fixtures
are temporary directories, independent of workspace memory.

With Docker available, validate Compose as well:

```bash
docker compose config --quiet
```

The publish workflow runs [`docker/smoke-tools.sh`](docker/smoke-tools.sh)
against the built image. It compares exact pinned versions and reports expected
and actual values on failure, accepting both bare and `opencode v<version>`
output. Image checks also cover default/custom-UID writes, tool execution,
configuration loading, chat overlay isolation, and command passthrough.

### Publishing the Runtime

[`.github/workflows/publish-runtime.yml`](.github/workflows/publish-runtime.yml)
builds and pushes `ghcr.io/hoshinokoji/opencode-runtime` for `linux/amd64`.
It runs manually through `workflow_dispatch` or on `runtime-v*` tags; ordinary
`main` commits do not publish.

Choose an unused release version, then create and push its tag. For example:

```bash
git tag -a runtime-v0.3.0 -m "Runtime 0.3.0"
git push origin runtime-v0.3.0
```

If the tag already exists locally, push it directly. Publishing begins only
after the tag is pushed.

The workflow builds once with version and commit-qualified tags, plus OCI
source/revision/version labels. It validates Compose and shell syntax, runs
tests and image smoke checks, and pushes that exact tested image. Publishes
are serialized and existing version tags cannot be overwritten.

Versions must be strict `X.Y.Z` SemVer, optionally with a prerelease suffix
such as `-rc.1`; build metadata (`+...`) is unsupported in Docker tags.
`latest` and `local` are reserved and rejected as release inputs. After all
checks and both versioned pushes succeed, stable releases also update `latest`.
Prereleases never update it. `latest` means the last successfully published
stable release in publish order, not the highest version: publishing an older
stable version moves it backward. Choose release order accordingly.

A first published GHCR package is private by default. For anonymous pulls, set
its visibility to **Public** in the
[package settings](https://github.com/users/HoshinoKoji/packages/container/opencode-runtime/settings).

To upgrade or roll back, select the desired published tag with `--image` or
`OPENCODE_IMAGE`; downstream extension builds select their base with
`RUNTIME_IMAGE`. Rebuild extension images when changing the base runtime.
