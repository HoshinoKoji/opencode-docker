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

> **Current default:** `./start.sh` uses
> `ghcr.io/hoshinokoji/opencode-runtime:0.2.4`, pulling it if needed. This release
> contains OpenCode `2.2.5` and the previous full toolchain. The slim runtime
> described in the developer guide is available through source builds until
> the next release.

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
| `serious` (default) | Calm, direct discussion and tasks needing follow-up | Reads and writes shared memory in `MEMORY.md` and `.sessions/` |
| `casual` | Relaxed, familiar conversation with light humor | May read shared memory; writes privately in `.sessions/casual/` by default |
| `temp` | One-off questions and temporary conversations | Workspace memory and file/command tools are disabled |

- `serious` and `casual` review available memory when a session starts. When a
  topic concludes, they save a record and retain useful enduring information.
  Say **“do not record”** to skip memory updates for that topic.
- Ask `casual` explicitly to share information if it should enter shared memory.
  `serious` does not access the private `casual` directory.
- Switching agents preserves the current conversation. Start a **new session**
  before switching to `temp` to isolate earlier context, or from `casual` to
  `serious` when private content needs to remain isolated.
- `temp` disables workspace memory recording; OpenCode's own session
  persistence still applies.

Agent definitions live in [`config/chat/`](config/chat/); memory procedures
are in [`AGENTS.md`](AGENTS.md). These chat agents are loaded by this workspace.
The reusable runtime provides neutral development defaults.

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
`--build` before any `--` separator.

#### Tool Versions

[`versions.env`](versions.env) is the single source of truth for local builds
and publishing. Explicit environment overrides win; there is no implicit
`latest` fallback.

| Tool | Version |
| --- | --- |
| Bun | `1.4.4` |
| uv | `0.13.8` |
| OpenCode | `2.2.5` |

For example, to build with a different pinned Bun version:

```bash
BUN_VERSION=1.3.15 ./start.sh --build
```

Bun and uv come from version-pinned official images. OpenCode V2 is installed
with `bun install -g --trust @opencode/cli@<version>` into `/usr/local`, where
every runtime UID can execute it. The official package handles platform
selection; the native CLI does not require Node.

When upgrading from V1, back up persistent configuration and data volumes.
Check custom plugins and providers against the
[V2 documentation](https://opencode.ai/v2/docs/); image smoke checks do not
validate every existing session migration or host configuration.

#### Build Networking and Compose Compatibility

The launcher exports the resolved Bake definition with
`docker compose build --print`, then runs Buildx with `--allow=network.host`,
repository-scoped `fs.read`, and `--load`. It then starts Compose with
`--no-build`. Compose resolves version pins, proxy arguments, and overrides.

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

### Focused Checks

Run the daemon-free version-smoke, configuration-mirror, and launcher checks:

```bash
uv run --no-project --with pytest pytest tests -q
sh -n start.sh
sh -n docker/entrypoint.sh
sh -n docker/smoke-tools.sh
```

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

A first published GHCR package is private by default. For anonymous pulls, set
its visibility to **Public** in the
[package settings](https://github.com/users/HoshinoKoji/packages/container/opencode-runtime/settings).

To upgrade or roll back, select the desired published tag with `--image` or
`OPENCODE_IMAGE`; downstream extension builds select their base with
`RUNTIME_IMAGE`. Rebuild extension images when changing the base runtime.
