# OpenCode Runtime and Personal Workspace

This repository publishes a general-purpose OpenCode runtime image and runs a
personal chat workspace on top of it. The runtime bundles OpenCode, uv, Node,
Bun, Rust, C/C++ build tools, fish, ripgrep, and common shell tools on Ubuntu
24.04. The chat workspace adds three primary agents: `serious` (the default,
with shared memory), `casual` (with private memory), and `temp` (for temporary
conversations).

The runtime is designed for reuse by other projects: an extension image adds
only its own toolchain, and a project Compose service extends the shared
runtime fragment. See [Using the runtime in another project](#using-the-runtime-in-another-project).

> **Bootstrap status:** the `ghcr.io/hoshinokoji/opencode-runtime` package has
> not been published yet. Until the first `runtime-v*` release is pushed, build
> the runtime from this checkout with `./start.sh --build` and point other
> projects at `ghcr.io/hoshinokoji/opencode-runtime:local` through
> `OPENCODE_RUNTIME_IMAGE`.

## Chat Agents

Switch between these three primary agents in the OpenCode interface for in-depth
discussion, relaxed conversation, or temporary questions:

| Agent | Style and use cases | Memory |
| --- | --- | --- |
| `serious` (default) | Calm and direct, leading with conclusions before explaining the reasoning. Suited to everyday tasks, in-depth discussions, and topics that need follow-up. | Reads and writes shared memory in `MEMORY.md` and `.sessions/`. |
| `casual` | Natural and relaxed, like a familiar friend, with light humor. Suited to casual chats, interests, and everyday matters. | Can read shared memory. Writes to its private `.sessions/casual/` space by default, and writes to shared memory when explicitly asked to share information. |
| `temp` | Natural and concise, using information provided in the current conversation. Suited to one-off questions and temporary discussions. | Workspace memory access and recording are disabled, along with file and command tools. |

The chat agents and their permissions live in [`config/chat/`](config/chat/).
They are loaded only by the chat workspace, not by the runtime's neutral
development defaults in [`config/opencode/`](config/opencode/). Restart OpenCode
after changing any configuration.

### Memory and Agent Switching

- `serious` and `casual` review the memory available to them at the start of a
  session. When a topic or task concludes, they save a summary and details for
  future follow-up, and add enduring information to long-term memory.
  Explicitly say "do not record" to skip memory updates for a topic.
- Shared records for `serious` live at the top level of `.sessions/`. Private
  records for `casual` live in `.sessions/casual/`, which `serious` does not
  access. Each space has its own `INDEX.md` for finding past topics.
- Switching agents preserves the messages already in the current session. To
  isolate earlier context, start a new session before selecting `temp`. Also
  start a new session when switching from `casual` to `serious` if private
  content needs to be isolated.
- The recording restriction in `temp` applies to workspace memory files.
  OpenCode's own session persistence still applies.

Memory rules are in [`AGENTS.md`](AGENTS.md).

## Running in a Container

The host needs Git, Docker, and Docker Compose v2 (with `extends` support).
Run the chat workspace from the repository directory:

```bash
./start.sh
```

This pulls `ghcr.io/hoshinokoji/opencode-runtime` (default tag `0.1.0`) unless a
local image with that name exists. The container runs OpenCode Web in the
background, listening on the host at `0.0.0.0:14096` by default. Open
<http://127.0.0.1:14096> in a local browser. Configure a model provider in the
interface on first use; credentials are not required to start the container.

Check the status, follow logs, or stop the service:

```bash
docker compose ps
docker compose logs -f opencode
docker compose down
```

### Building From Source

To build the runtime image locally from this checkout:

```bash
./start.sh --build
```

The build reads pinned tool versions from [`versions.env`](versions.env) and
tags the local image `ghcr.io/hoshinokoji/opencode-runtime:local`. To test a
development version, override a value in the environment:

```bash
BUN_VERSION=1.3.15 ./start.sh --build
```

`versions.env` is the single source of truth for local builds and the publish
workflow; no build falls back to an implicit `latest`. The current pins are:

| Tool | Version |
| --- | --- |
| Bun | `1.3.14` |
| Node.js | `24.15.0` |
| uv | `0.12.23` |
| OpenCode | `1.18.35` |
| Rust | `1.99.0` |

Build only, without starting the service:

```bash
set -a; . ./versions.env; set +a
docker compose -f compose.yaml -f compose.build.yaml build opencode
```

### Publishing the Runtime

The workflow [`.github/workflows/publish-runtime.yml`](.github/workflows/publish-runtime.yml)
builds and pushes `ghcr.io/hoshinokoji/opencode-runtime` for `linux/amd64`
only. It runs exclusively on manual `workflow_dispatch` or on tags matching
`runtime-v*`; ordinary `main` commits do not publish.

To publish a release, create and push a tag:

```bash
git tag runtime-v0.1.0
git push origin runtime-v0.1.0
```

The image is built once with the version tag (`:0.1.0`), a commit-qualified tag
(`:0.1.0-<sha>`), and OCI labels that record the source repository, revision,
and version. Before pushing that exact image, the workflow validates the Compose
files and shell syntax, checks the tool versions, verifies `opencode debug
config` resolves the neutral defaults with no chat agent, compiles and runs a
small Rust program and writes config/cache/cargo as both the default UID and a
configured non-root UID, and checks command/argument passthrough. A `concurrency`
group serializes publishes for the same version, and the workflow refuses to
overwrite an existing version tag, so bump the version for a new release.

The first published package is **private** by default. To let other projects
pull it anonymously, open the package settings on GitHub
(`https://github.com/users/HoshinoKoji/packages/container/opencode-runtime/settings`)
and change its visibility to **Public**.

Upgrade and roll back by changing the tag:

- **Upgrade:** edit the `OPENCODE_RUNTIME_IMAGE` / image tag used by a project,
  or `OPENCODE_IMAGE` here, to the new version.
- **Roll back:** pin the previous version tag. Extension images must be rebuilt
  when the runtime changes.

### Selecting the Listen Address and Port

The default listen address, `0.0.0.0`, allows access from other devices on the
same network. To choose a port (such as `8090`) and set an access password:

```bash
export OPENCODE_BIND_ADDRESS=0.0.0.0
export OPENCODE_PORT=8090
export OPENCODE_SERVER_PASSWORD='replace-with-your-password'
./start.sh
```

Then open `http://<host-ip>:8090`. The default username is `opencode`; set
`OPENCODE_SERVER_USERNAME` to change it. With host networking, OpenCode listens
directly on the host: `OPENCODE_BIND_ADDRESS` controls the listening interface
and `OPENCODE_PORT` controls the port.

### Using a Host Proxy

If a proxy listens on the host at `127.0.0.1:7890`, export the standard proxy
variables before starting. The shared service passes `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` (and their lowercase forms) to the
container:

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY="$HTTP_PROXY"
./start.sh
```

Host networking is the explicit choice that lets the container reach a proxy on
the host's loopback address. Projects that do not need it use the default bridge
network.

### Configuring Git Commit Identity

`start.sh` reads `user.name` and `user.email` on the host using
`git config --global`, then passes them into the container as the author and
committer identity. Git resolves the global configuration location itself,
supporting both `~/.gitconfig` and XDG configuration paths.

```bash
git config --global user.name 'Your Name'
git config --global user.email 'you@example.com'
./start.sh
```

When using `docker compose up` directly, supply `GIT_AUTHOR_NAME`,
`GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` yourself.

### Workspace, Configuration, and State

The chat workspace bind-mounts this repository at `/home/bun/workspace`.
`start.sh` creates `projects/` for development at
`/home/bun/workspace/projects/`; Git ignores this directory, and it is excluded
from the Docker build context.

Global OpenCode configuration is intentionally split:

- The shared host preferences are bind-mounted **read-only** at
  `/opt/opencode-config-source`. Both launchers prefer `$HOME/.config/opencode`
  when present, otherwise the neutral [`config/opencode/`](config/opencode/).
  Set `OPENCODE_CONFIG_SOURCE` to use the same source across all environments.
- On every start the entrypoint mirrors that source into the writable
  per-instance `opencode-config` volume at `/home/bun/.config/opencode`,
  excluding generated dependency files. Plugin dependencies and caches stay in
  the instance volume, so the host source is never modified and instances do not
  share `node_modules`.
- Because the mirror runs on every start, editing the source and restarting
  reloads the new configuration, and deleting an agent in the source removes the
  stale copy. OpenCode still merges global and project configuration natively.
- The chat workspace additionally mounts [`config/chat/`](config/chat/)
  read-only at `/opt/opencode-profile-source`. Its agents are copied into the
  instance mirror, and its JSONC is loaded through native `OPENCODE_CONFIG`
  precedence (after global preferences, before project settings). This preserves
  shared models/providers while adding the `serious` default and memory rules.

Without a source mount, the entrypoint seeds the baked neutral defaults from
[`config/opencode/`](config/opencode/) once, so a plain `docker run` remains
usable.

OpenCode authentication and session data are stored in the persistent
`opencode-data` volume (per Compose project). To reuse host credentials instead,
add a read-only directory bind in `compose.override.yaml`:

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

The entrypoint imports `auth.json`/`account.json` only when their instance copies
are absent. Refreshed tokens remain writable in instance state, while the source
stays unchanged. Credentials can also be configured in the interface on first
run, with no credential bind.

After changing configuration on the host, restart the container and quit and
restart any open OpenCode TUI instances:

```bash
docker compose restart opencode
```

### Mounting Existing Projects and Read-Only Directories

Mount existing host directories into the same container with a local
`compose.override.yaml`. Copy the example:

```bash
cp compose.override.example.yaml compose.override.yaml
```

Edit each `source` to an existing absolute directory and each `target` to a
distinct path under `/home/bun/workspace/projects/<name>`. `read_only: false`
creates a writable mount; `read_only: true` is suitable for reference material.

`./start.sh` uses Compose's automatic discovery of `compose.yaml` and
`compose.override.yaml`. It explicitly re-adds `compose.override.yaml` when it
loads build files with `-f`, so overrides are never silently dropped.

### Shell Access

The service process runs as the host UID/GID (`OPENCODE_UID`/`OPENCODE_GID`),
so mounted files keep the expected ownership. `docker compose exec` starts from
the image's default user (root), so pass the host user explicitly for an
equivalent shell:

```bash
docker compose exec -u "$(id -u):$(id -g)" opencode sh
docker compose exec -u "$(id -u):$(id -g)" opencode opencode
```

## Using the Runtime in Another Project

An extension image starts `FROM ghcr.io/hoshinokoji/opencode-runtime:<version>`
and adds only its project-specific toolchain. A project Compose service extends
the shared fragment with `extends` (not `include`, which conflicts on resource
names rather than merging the same service):

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
      # Read-only shared configuration source.
      - type: bind
        source: /absolute/host/opencode-config
        target: /opt/opencode-config-source
        read_only: true
      # Read-only shared skills.
      - type: bind
        source: /absolute/host/claude-skills
        target: /opt/claude-skills
        read_only: true
    # Project-specific: networks, ports, depends_on, extra services.
    ports:
      - "4096:4096"

# `extends` does not import top-level resources, so declare the named volumes
# the fragment references.
volumes:
  opencode-config:
  opencode-data:
  opencode-cache:
  opencode-cargo:
```

Set `OPENCODE_DOCKER_ROOT` to the directory of a clone of this repository. To
change the home, set `OPENCODE_HOME` in the host environment or project `.env`
before Compose interpolation, so all environment and volume targets agree.
The fragment centralizes
UID/GID handling, Git identity, proxy variables, the writable instance volumes,
and the environment; `OPENCODE_IMAGE`, `OPENCODE_UID`, `OPENCODE_GID`,
`OPENCODE_WORKING_DIR`, and `OPENCODE_PORT` are also read from the environment.

The named volumes must be declared by the consuming Compose file. Keeping them
per project isolates sessions; mounting a shared configuration directory
read-only at `/opt/opencode-config-source` shares the source without sharing
generated dependency installs.

The entrypoint mirrors the read-only source into the instance config volume,
drops root to `OPENCODE_UID:OPENCODE_GID`, and execs the requested command.
Without a source it seeds the baked neutral defaults. `docker run <image>
Rscript script.R` and similar extension commands therefore run normally.

Shared skills live in [`config/skills/`](config/skills/) and are conventionally
mounted read-only at `/opt/claude-skills`.

## Focused Checks

Run the daemon-free configuration-mirror and launcher checks with uv:

```bash
uv run --no-project --with pytest pytest tests -q
sh -n start.sh docker/entrypoint.sh
docker compose config --quiet
```

The publish workflow also verifies the built image's pinned tool versions,
default and custom-UID write access, Rust compilation, and OpenCode configuration
loading before pushing the exact tested image.
