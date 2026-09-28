# OpenCode 个人工作区

这个工作区使用 OpenCode 的三个主 agent：`serious`（默认，共享记忆）、`casual`（专享记忆）和 `temp`（临时聊天）。项目配置见 `opencode.jsonc`，工作区规则见 `AGENTS.md`。

## 聊天 agent

仓库提供三个可在 OpenCode 界面中切换的主 agent，分别适合深入讨论、轻松交流和临时问答：

| Agent | 风格与适用场景 | 记忆方式 |
| --- | --- | --- |
| `serious`（默认） | 平实、直接，先给结论再解释依据；适合日常事务、深入讨论和需要持续跟进的话题。 | 读写共享记忆 `MEMORY.md` 和 `.sessions/`。 |
| `casual` | 像熟悉的朋友一样自然轻松，适度幽默；适合闲聊、兴趣话题和日常小事。 | 可读取共享记忆，默认将记录写入自己的 `.sessions/casual/` 空间；明确要求分享时才写入共享记忆。 |
| `temp` | 自然、简洁，围绕当前聊天中提供的信息回答；适合一次性问答和临时讨论。 | 不读取或写入工作区记忆，文件与命令工具已禁用。 |

### 记忆与切换

- `serious` 和 `casual` 会在会话开始时回顾各自可访问的记忆，在一个话题或任务结束时保存摘要和可供后续接续的细节，并将有长期价值的信息整理到长期记忆中。明确说“不要记录”即可跳过该话题的记忆写入。
- `serious` 使用的共享记录保存在 `.sessions/` 顶层；`casual` 的专享记录保存在 `.sessions/casual/`，`serious` 不访问该子目录。两者都通过各自的 `INDEX.md` 索引历史话题。
- 切换 agent 会保留当前会话已有的消息。需要隔离先前上下文时，应新建会话再选择 `temp`；从 `casual` 转到 `serious` 且需要隔离专享内容时，也应新建会话。
- `temp` 的“不记录”指工作区记忆文件；OpenCode 自身的会话保存机制仍然适用。

三个 agent 的提示词与权限定义位于 [`.opencode/agents/`](.opencode/agents/)，记忆规则见 [`AGENTS.md`](AGENTS.md)。修改配置后，重启 OpenCode 生效。

## 在容器中运行

宿主机需要 Git、Docker 和 Docker Compose。在本目录执行：

```bash
./start.sh --build
```

容器在后台运行 OpenCode Web，默认在宿主机的 `0.0.0.0:14096` 监听，本机浏览器打开 <http://127.0.0.1:14096>。镜像内置 OpenCode 1.18.32、Bun、uv 和 Git。首次使用时，可在界面中配置模型服务。

查看状态与日志、停止服务：

```bash
docker compose ps
docker compose logs -f opencode
docker compose down
```

### 设置监听地址和端口

默认监听地址 `0.0.0.0` 可供同一网络的其他设备访问；如需指定端口（示例为 `8090`）并设置访问密码：

```bash
export OPENCODE_BIND_ADDRESS=0.0.0.0
export OPENCODE_PORT=8090
export OPENCODE_SERVER_PASSWORD='换成自己的密码'
./start.sh --build
```

然后访问 `http://<宿主机IP>:8090`，用户名默认为 `opencode`；需要更改时设置 `OPENCODE_SERVER_USERNAME`。外部访问请设置密码。这里使用 Linux host 网络，端口由 OpenCode 直接在宿主机监听，`OPENCODE_BIND_ADDRESS` 控制可访问范围，`OPENCODE_PORT` 控制监听端口；无需另外配置 Docker 端口映射。修改变量后重新执行 `./start.sh` 生效。

### 使用宿主机代理

如果代理监听在宿主机的 `127.0.0.1:7890`，先在当前终端设置环境变量，再构建和运行；按实际端口修改示例：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY="$HTTP_PROXY"

./start.sh --build
```

`compose.yaml` 会将 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 传给构建过程和运行中的容器，也会在运行时透传对应的小写变量。构建与运行均使用 Linux host 网络，因此容器可以访问宿主机的回环地址代理；代理地址由环境变量提供，不会写入镜像。

### 配置 Git 提交身份

`start.sh` 在宿主机通过 `git config --global` 读取 `user.name` 和 `user.email`，通过环境变量将这两个值作为作者和提交者身份传入容器。全局配置的文件位置由 Git 自行解析，支持 `~/.gitconfig` 和 XDG 配置路径。

可以在宿主机检查当前全局身份：

```bash
git config --global --get user.name
git config --global --get user.email
```

首次配置时，在宿主机执行：

```bash
git config --global user.name '你的名字'
git config --global user.email 'you@example.com'
./start.sh
```

脚本执行 `docker compose up -d`，附加参数会原样转发，例如 `./start.sh --build`。宿主机更新身份后，重新执行 `./start.sh` 即可应用，无需重新构建镜像。全局身份尚未配置时仍可启动服务，Git 提交需要先补齐姓名和邮箱。直接使用 `docker compose up` 时，需要自行提供这四个环境变量：`GIT_AUTHOR_NAME`、`GIT_AUTHOR_EMAIL`、`GIT_COMMITTER_NAME`、`GIT_COMMITTER_EMAIL`。

### 工作区与依赖

Compose 将当前目录挂载到容器的 `/home/bun/workspace`，在容器中修改文件会同步到宿主机。`start.sh` 会创建 `projects/`，可在容器内的 `/home/bun/workspace/projects/` 开发项目；该目录被 Git 和 Docker 构建上下文忽略。OpenCode 的登录和会话数据保存在 `opencode-data` 卷中，容器退出后仍可继续使用。镜像包含 `AGENTS.md`、`MEMORY.md`、`opencode.jsonc` 和 `.opencode/` 配置；`.sessions/`（含 `casual/`）等本地会话记录不打包进镜像，挂载工作区后可在容器内使用。

需要使用 uv 或 Bun 管理项目依赖时，可以进入正在运行的容器：

```bash
docker compose exec opencode sh
```

在对应项目目录初始化后使用 `uv add <包名>` 或 `bun add <包名>`。容器以 UID 1000 的 `bun` 用户运行，挂载的工作区需要对该用户可写。

需要使用终端交互界面时，可以在正在运行的容器中启动 OpenCode TUI：

```bash
docker compose exec opencode opencode
```
