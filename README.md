# OpenCode Personal Workspace

This workspace provides three primary OpenCode agents: `serious` (the default, with shared memory), `casual` (with private memory), and `temp` (for temporary conversations). The container's global configuration is in [`config/opencode/opencode.jsonc`](config/opencode/opencode.jsonc), and workspace rules are in `AGENTS.md`.

## Chat Agents

Switch between these three primary agents in the OpenCode interface for in-depth discussion, relaxed conversation, or temporary questions:

| Agent | Style and use cases | Memory |
| --- | --- | --- |
| `serious` (default) | Calm and direct, leading with conclusions before explaining the reasoning. Suited to everyday tasks, in-depth discussions, and topics that need follow-up. | Reads and writes shared memory in `MEMORY.md` and `.sessions/`. |
| `casual` | Natural and relaxed, like a familiar friend, with light humor. Suited to casual chats, interests, and everyday matters. | Can read shared memory. Writes to its private `.sessions/casual/` space by default, and writes to shared memory when explicitly asked to share information. |
| `temp` | Natural and concise, using information provided in the current conversation. Suited to one-off questions and temporary discussions. | Workspace memory access and recording are disabled, along with file and command tools. |

### Memory and Agent Switching

- `serious` and `casual` review the memory available to them at the start of a session. When a topic or task concludes, they save a summary and details for future follow-up, and add enduring information to long-term memory. Explicitly say "do not record" to skip memory updates for a topic.
- Shared records for `serious` live at the top level of `.sessions/`. Private records for `casual` live in `.sessions/casual/`, which `serious` does not access. Each space has its own `INDEX.md` for finding past topics.
- Switching agents preserves the messages already in the current session. To isolate earlier context, start a new session before selecting `temp`. Also start a new session when switching from `casual` to `serious` if private content needs to be isolated.
- The recording restriction in `temp` applies to workspace memory files. OpenCode's own session persistence still applies.

Agent prompts and permissions are defined in [`config/opencode/agents/`](config/opencode/agents/) and loaded as global agents inside the container. Memory rules are in [`AGENTS.md`](AGENTS.md). Restart OpenCode after changing its configuration.

## Running in a Container

The host needs Git, Docker, and Docker Compose. Looking up the latest versions during a build also requires curl. Run this command from the repository directory:

```bash
./start.sh --build
```

The container runs OpenCode Web in the background, listening on the host at `0.0.0.0:14096` by default. Open <http://127.0.0.1:14096> in a local browser. The image includes the versions of OpenCode and uv selected at build time, along with Bun and Git. Configure a model provider in the interface on first use.

Check the status, follow logs, or stop the service:

```bash
docker compose ps
docker compose logs -f opencode
docker compose down
```

### Selecting Build Versions

When you run `./start.sh --build`, the script looks up exact version numbers from the latest stable releases on the official uv and OpenCode GitHub repositories. In an interactive terminal, it prompts for each version: press Enter to use the latest release, or enter a specific version number. Version numbers may include a `v` prefix.

You can also set one or both versions through environment variables ahead of time. Explicit versions are used directly for the build. For example:

```bash
UV_VERSION=0.12.19 OPENCODE_VERSION=1.18.32 ./start.sh --build
```

Versions that are unset or set to `latest` trigger a latest-release lookup. Non-interactive runs automatically use the lookup results. When both versions are explicitly specified, the build can proceed without curl on the host. A failed lookup prints an error and exits; check your network connection or specify a version before retrying.

The `--build` option triggers version lookups and interactive selection. Use `./start.sh` for routine startup or runtime configuration updates. Selected versions are passed to the Dockerfile through Compose's `build.args` and shown in the script output and image build logs.

### Setting the Listen Address and Port

The default listen address, `0.0.0.0`, allows access from other devices on the same network. To choose a port (such as `8090`) and set an access password:

```bash
export OPENCODE_BIND_ADDRESS=0.0.0.0
export OPENCODE_PORT=8090
export OPENCODE_SERVER_PASSWORD='replace-with-your-password'
./start.sh --build
```

Then open `http://<host-ip>:8090`. The default username is `opencode`; set `OPENCODE_SERVER_USERNAME` to change it. Set a password when allowing access from other devices. With Linux host networking, OpenCode listens directly on the host: `OPENCODE_BIND_ADDRESS` controls the listening interface, and `OPENCODE_PORT` controls the port. Run `./start.sh` again after changing these variables.

### Using a Host Proxy

If a proxy listens on the host at `127.0.0.1:7890`, set these environment variables in your terminal before building and running. Adjust the port to match your proxy:

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY="$HTTP_PROXY"

./start.sh --build
```

`compose.yaml` passes `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` to both the build and the running container. It also passes their lowercase equivalents at runtime. Both building and running use Linux host networking, so the container can reach a proxy on the host's loopback address. Proxy addresses are supplied through environment variables rather than stored in the image.

### Configuring Git Commit Identity

`start.sh` reads `user.name` and `user.email` on the host using `git config --global`, then passes them into the container as the author and committer identity through environment variables. Git resolves the global configuration location itself, supporting both `~/.gitconfig` and XDG configuration paths.

Check the current global identity on the host:

```bash
git config --global --get user.name
git config --global --get user.email
```

To configure it for the first time, run these commands on the host:

```bash
git config --global user.name 'Your Name'
git config --global user.email 'you@example.com'
./start.sh
```

The script runs `docker compose up -d` and forwards additional arguments as provided, such as `./start.sh --build`. After updating the host identity, run `./start.sh` again to apply it; rebuilding the image is unnecessary. The service can start before a global identity is configured, but Git commits require a name and email. When using `docker compose up` directly, supply these four environment variables yourself: `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL`.

### Mounting Existing Projects and Read-Only Directories

Mount existing directories from anywhere on the host into the same OpenCode container by specifying their paths in a local `compose.override.yaml`. The repository provides [`compose.override.example.yaml`](compose.override.example.yaml) with examples for a writable project directory and a read-only reference directory.

Copy the example in the repository root:

```bash
cp compose.override.example.yaml compose.override.yaml
```

Edit `compose.override.yaml`:

- Set `source` to an existing directory on the host. The example uses absolute paths; relative paths are also supported and are resolved relative to this repository. The example's `bind.create_host_path: false` requires the source directory to exist.
- Set `target` to the path used to access the directory inside the container, preferably `/home/bun/workspace/projects/<directory-name>`. Use a distinct target path for each directory.
- `read_only: false` creates a writable mount, so changes inside the container update the original host directory. `read_only: true` creates a read-only mount suitable for reference documentation or source lookup.

After setting the actual paths, inspect the merged configuration and start the service:

```bash
docker compose config
./start.sh
```

`start.sh` sets the repository as the Compose project directory, allowing Compose to discover `compose.yaml` and the optional `compose.override.yaml` automatically. Additional mounts are merged into the same `opencode` service by their container target paths, alongside the workspace, global configuration, and data volume from the base configuration. The local `compose.override.yaml` is ignored by Git and excluded from the Docker build context.

After adding, removing, or changing mounts, run `./start.sh` again. Compose recreates the container to apply configuration changes without rebuilding the image. `docker compose restart` restarts the existing container without applying mount changes. To remove all additional mounts, delete the local `compose.override.yaml` and run `./start.sh` again.

### Workspace and Dependencies

Compose mounts this repository at `/home/bun/workspace` inside the container. File changes inside the container are reflected on the host. `start.sh` creates `projects/` for development at `/home/bun/workspace/projects/`; Git ignores this directory, and it is excluded from the Docker build context. OpenCode authentication and session data are stored in the persistent `opencode-data` volume for reuse after the container exits.

`config/opencode/` is mounted separately at `/home/bun/.config/opencode/` inside the container. Its `opencode.jsonc` and `agents/` are loaded as global configuration for all project directories in the container. Project-specific configuration can override global settings. After changing the configuration on the host, run `docker compose restart opencode` and quit and restart any open OpenCode TUI instances to load the new settings.

The image includes the workspace's `AGENTS.md` and `MEMORY.md`, along with global configuration at `/home/bun/.config/opencode/`. Local conversation records such as `.sessions/` (including `casual/`) are available through the workspace mount and are excluded from the image.

To manage project dependencies with uv or Bun, open a shell in the running container:

```bash
docker compose exec opencode sh
```

Initialize your project in its directory, then use `uv add <package>` or `bun add <package>`. The container runs as the `bun` user with UID 1000, so the mounted workspace must be writable by that user.

To use the terminal interface, start OpenCode TUI in the running container:

```bash
docker compose exec opencode opencode
```
