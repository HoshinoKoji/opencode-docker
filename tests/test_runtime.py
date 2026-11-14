"""Focused checks for installation, config mirroring, and launching; no daemon needed."""

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = ROOT / "docker" / "entrypoint.sh"


def run_entrypoint(home, source, *command, auth_source=None, profile_source=None):
    env = os.environ.copy()
    for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CARGO_HOME"):
        env.pop(key, None)
    env.update(
        HOME=str(home),
        OPENCODE_HOME=str(home),
        OPENCODE_CONFIG_INPUT=str(source),
        OPENCODE_AUTH_INPUT=str(auth_source or home.parent / "no-auth"),
        OPENCODE_UID=str(os.getuid()),
        OPENCODE_GID=str(os.getgid()),
    )
    env.pop("OPENCODE_CONFIG", None)
    env.pop("OPENCODE_PROFILE_INPUT", None)
    if profile_source:
        env["OPENCODE_PROFILE_INPUT"] = str(profile_source)
    return subprocess.run(
        ["sh", str(ENTRYPOINT), *command],
        env=env,
        cwd=home.parent,
        text=True,
        capture_output=True,
        check=True,
    )


def test_config_updates_and_deletions_keep_instance_dependencies(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "opencode.jsonc").write_text('{"model":"provider/first"}')
    (source / "agents").mkdir()
    (source / "agents" / "old.md").write_text("old agent")
    (source / "package.json").write_text('{"dependencies":{"plugin-lib":"1.0.0"}}')
    (source / "package.json").chmod(0o444)
    (source / "agents").chmod(0o555)
    (source / "node_modules").mkdir()
    (source / "node_modules" / "host-only").write_text("do not copy")

    home = tmp_path / "instance"
    run_entrypoint(home, source, "sh", "-c", "printf '%s-%s' \"$1\" \"$2\"", "sh", "alpha beta", "gamma")
    mirror = home / ".config" / "opencode"
    assert (mirror / "opencode.jsonc").read_text() == (source / "opencode.jsonc").read_text()
    assert json.loads((mirror / "package.json").read_text())["dependencies"] == {"plugin-lib": "1.0.0"}
    assert not (mirror / "node_modules").exists()
    (mirror / "package.json").write_text('{"dependencies":{"plugin-lib":"1.0.0","generated":"1"}}')

    (mirror / "node_modules").mkdir()
    (mirror / "node_modules" / "instance-only").write_text("keep")
    (mirror / "bun.lock").write_text("generated lock")
    (source / "agents").chmod(0o755)
    (source / "agents" / "old.md").unlink()
    (source / "opencode.jsonc").write_text('{"model":"provider/second"}')
    result = run_entrypoint(home, source, "sh", "-c", "printf '%s-%s' \"$1\" \"$2\"", "sh", "alpha beta", "gamma")

    assert result.stdout == "alpha beta-gamma"
    assert result.stderr == ""
    assert not (mirror / "agents" / "old.md").exists()
    assert json.loads((mirror / "opencode.jsonc").read_text())["model"] == "provider/second"
    assert (mirror / "node_modules" / "instance-only").read_text() == "keep"
    assert (mirror / "bun.lock").read_text() == "generated lock"
    assert not (source / "node_modules" / "instance-only").exists()


def test_credentials_are_seeded_once_and_refreshes_survive_restart(tmp_path):
    source = tmp_path / "config"
    source.mkdir()
    (source / "opencode.jsonc").write_text("{}")
    auth = tmp_path / "auth-source"
    auth.mkdir()
    (auth / "auth.json").write_text('{"token":"seed"}')
    home = tmp_path / "instance"

    run_entrypoint(home, source, "true", auth_source=auth)
    credentials = home / ".local" / "share" / "opencode" / "auth.json"
    assert credentials.read_text() == '{"token":"seed"}'
    assert credentials.stat().st_mode & 0o777 == 0o600
    credentials.write_text('{"token":"refreshed"}')
    run_entrypoint(home, source, "true", auth_source=auth)

    assert credentials.read_text() == '{"token":"refreshed"}'
    assert (auth / "auth.json").read_text() == '{"token":"seed"}'


def test_chat_profile_keeps_the_shared_global_preferences(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "opencode.jsonc").write_text('{"model":"provider/shared"}')
    home = tmp_path / "instance"
    result = run_entrypoint(
        home, source, "sh", "-c", 'printf "%s" "$OPENCODE_CONFIG"',
        profile_source=ROOT / "config/chat",
    )
    mirror = home / ".config/opencode"
    assert json.loads((mirror / "opencode.jsonc").read_text())["model"] == "provider/shared"
    assert result.stdout == str(mirror / ".runtime-profile/opencode.jsonc")
    assert (mirror / "agents/serious.md").is_file()

    run_entrypoint(home, source, "true")
    assert not (mirror / "agents/serious.md").exists()
    assert not (mirror / ".runtime-profile").exists()


@pytest.fixture
def launcher_workspace(tmp_path):
    workspace = tmp_path / "workspace with spaces"
    workspace.mkdir()
    shutil.copy(ROOT / "start.sh", workspace / "start.sh")
    shutil.copy(ROOT / "versions.env", workspace / "versions.env")
    for name in ("compose.yaml", "compose.build.yaml", "compose.override.yaml"):
        (workspace / name).write_text("services: {}\n")

    tools = tmp_path / "bin"
    tools.mkdir()
    args_log = tmp_path / "docker-args"
    versions_log = tmp_path / "versions"
    bake_log = tmp_path / "bake-definition"
    temporary = tmp_path / "temporary"
    temporary.mkdir()
    docker = tools / "docker"
    docker.write_text(
        '#!/bin/sh\n'
        'set -eu\n'
        'printf "%s\\000" "$@" >> "$ARGS_LOG"\n'
        'printf "\\000" >> "$ARGS_LOG"\n'
        'printf "%s\\n" "$BUN_VERSION" "$OPENCODE_VERSION" "$OPENCODE_DEFAULT_CONFIG_SOURCE" > "$VERSIONS_LOG"\n'
        'for key in OPENCODE_PORT OPENCODE_BIND_ADDRESS OPENCODE_IMAGE OPENCODE_CONFIG_SOURCE OPENCODE_SKILLS_SOURCE OPENCODE_HTTP_PROXY OPENCODE_HTTPS_PROXY HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do\n'
        '  printf "%s=" "$key"\n'
        '  printenv "$key" || printf "<unset>\\n"\n'
        'done > "$VERSIONS_LOG.env"\n'
        'if [ "$1" = compose ]; then\n'
        '  for argument in "$@"; do\n'
        '    if [ "$argument" = --print ]; then\n'
        '      if [ "$FAILURE" = print ]; then exit 7; fi\n'
        '      printf "%s\\n" \'{"target":{"opencode":{"context":"resolved-context"}}}\'\n'
        '    fi\n'
        '  done\n'
        'elif [ "$1" = buildx ]; then\n'
        '  cp "$4" "$BAKE_LOG"\n'
        '  if [ "$FAILURE" = bake ]; then exit 8; fi\n'
        'fi\n'
    )
    docker.chmod(0o755)
    env = os.environ.copy()
    env.update(
        PATH=f"{tools}:{env['PATH']}",
        ARGS_LOG=str(args_log),
        VERSIONS_LOG=str(versions_log),
        BAKE_LOG=str(bake_log),
        TMPDIR=str(temporary),
        FAILURE="",
        BUN_VERSION="9.8.7",
        HOME=str(tmp_path / "home"),
    )
    env.pop("OPENCODE_CONFIG_SOURCE", None)
    env.pop("OPENCODE_VERSION", None)
    env.pop("OPENCODE_IMAGE", None)
    return workspace, env, args_log, versions_log, bake_log, temporary


def launcher_calls(args_log):
    return [
        entry.decode().split("\0")
        for entry in args_log.read_bytes().rstrip(b"\0").split(b"\0\0")
    ]


@pytest.mark.parametrize("build", [False, True])
@pytest.mark.parametrize("opencode_override", [None, "2.0.0"])
@pytest.mark.parametrize("with_override", [False, True])
def test_launcher_keeps_overrides_versions_and_paths_with_spaces(
    launcher_workspace, tmp_path, build, opencode_override, with_override,
):
    workspace, env, args_log, versions_log, bake_log, temporary = launcher_workspace
    if not with_override:
        (workspace / "compose.override.yaml").unlink()
    if opencode_override:
        env["OPENCODE_VERSION"] = opencode_override
    command = ["sh", str(workspace / "start.sh")]
    if build:
        command.append("--build")
    subprocess.run(command, cwd=tmp_path, env=env, check=True)

    calls = launcher_calls(args_log)
    prefix = ["compose", "--project-directory", str(workspace)]
    if build:
        prefix += [
            "-f", str(workspace / "compose.yaml"),
            "-f", str(workspace / "compose.build.yaml"),
        ]
        if with_override:
            prefix += ["-f", str(workspace / "compose.override.yaml")]
        assert len(calls) == 3
        assert calls[0] == prefix + ["build", "--print", "opencode"]
        assert calls[1][:3] == ["buildx", "bake", "--file"]
        assert calls[1][4:] == [
            "--allow=network.host", f"--allow=fs.read={workspace}", "--load", "opencode",
        ]
        assert json.loads(bake_log.read_text()) == {
            "target": {"opencode": {"context": "resolved-context"}},
        }
        assert not Path(calls[1][3]).exists()
        assert calls[2] == prefix + ["up", "-d", "--no-build"]
    else:
        assert calls == [prefix + ["up", "-d"]]
        assert not bake_log.exists()
    assert not list(temporary.iterdir())
    assert versions_log.read_text().splitlines() == [
        "9.8.7", opencode_override or "2.2.5", str(workspace / "config" / "opencode")
    ]


@pytest.mark.parametrize("failure,expected_count", [("print", 1), ("bake", 2)])
def test_launcher_does_not_start_after_a_failed_build(launcher_workspace, tmp_path, failure, expected_count):
    workspace, env, args_log, _, _, temporary = launcher_workspace
    env["FAILURE"] = failure
    result = subprocess.run(
        ["sh", str(workspace / "start.sh"), "--build"],
        cwd=tmp_path, env=env, text=True, capture_output=True,
    )
    assert result.returncode != 0
    calls = launcher_calls(args_log)
    assert len(calls) == expected_count
    assert not any("up" in call for call in calls)
    assert not list(temporary.iterdir())


def test_launcher_build_consumes_switch_and_keeps_up_arguments(launcher_workspace, tmp_path):
    workspace, env, args_log, _, _, _ = launcher_workspace
    subprocess.run(
        ["sh", str(workspace / "start.sh"), "--build=true", "--", "--wait", "--timeout", "60", "opencode"],
        cwd=tmp_path, env=env, check=True,
    )
    calls = launcher_calls(args_log)
    assert calls[-1][-7:] == ["up", "-d", "--no-build", "--wait", "--timeout", "60", "opencode"]
    assert "--build=true" not in calls[-1]


@pytest.mark.parametrize("arguments", [
    ["--port"], ["--port="], ["--port", "--build"], ["--port", "0"],
    ["--port", "65536"], ["--port", "abc"], ["--port", "999999999999999999999"],
    ["--image="], ["--config-source="], ["--prot", "8090"], ["--wait"],
])
def test_launcher_rejects_invalid_flags_before_side_effects(launcher_workspace, arguments):
    workspace, env, args_log, _, _, _ = launcher_workspace
    result = subprocess.run(
        ["sh", str(workspace / "start.sh"), *arguments],
        env=env, text=True, capture_output=True,
    )
    assert result.returncode == 2
    assert "--help" in result.stderr
    assert not args_log.exists()
    assert not (workspace / "projects").exists()


def test_launcher_help_needs_no_tools_or_versions(launcher_workspace):
    workspace, env, args_log, _, _, _ = launcher_workspace
    (workspace / "versions.env").write_text("exit 99\n")
    result = subprocess.run(
        ["sh", str(workspace / "start.sh"), "--help"],
        env=env, text=True, capture_output=True,
    )
    assert result.returncode == 0
    assert "--disable-proxy" in result.stdout
    assert "COMPOSE_UP_ARGUMENTS" in result.stdout
    assert not args_log.exists()
    assert not (workspace / "projects").exists()


@pytest.mark.parametrize("build", [False, True])
def test_launcher_flags_override_environment_and_keep_quoted_values(launcher_workspace, build):
    workspace, env, args_log, versions_log, _, _ = launcher_workspace
    env.update(OPENCODE_PORT="1000", OPENCODE_IMAGE="old:image", OPENCODE_HTTP_PROXY="old")
    flags = [
        "--port=8090", "--port", "8091", "--bind", "127.0.0.1",
        "--image=new:image", "--config-source", "config with spaces",
        "--skills-source=skills with spaces", "--proxy", "http://proxy:7890",
        "--https-proxy=https://secure:7891", "--no-proxy=localhost,127.0.0.1",
    ]
    if build:
        flags.append("--build")
    subprocess.run(
        ["sh", str(workspace / "start.sh"), *flags, "--", "--timeout", "60", "service name"],
        env=env, check=True,
    )
    settings = dict(line.split("=", 1) for line in Path(f"{versions_log}.env").read_text().splitlines())
    assert settings["OPENCODE_PORT"] == "8091"
    assert settings["OPENCODE_BIND_ADDRESS"] == "127.0.0.1"
    assert settings["OPENCODE_IMAGE"] == "new:image"
    assert settings["OPENCODE_CONFIG_SOURCE"] == "config with spaces"
    assert settings["OPENCODE_SKILLS_SOURCE"] == "skills with spaces"
    assert settings["OPENCODE_HTTP_PROXY"] == "http://proxy:7890"
    assert settings["OPENCODE_HTTPS_PROXY"] == "https://secure:7891"
    assert settings["NO_PROXY"] == "localhost,127.0.0.1"
    assert launcher_calls(args_log)[-1][-3:] == ["--timeout", "60", "service name"]


@pytest.mark.parametrize("enable_again", [False, True])
def test_launcher_disable_proxy_clears_every_fallback(launcher_workspace, enable_again):
    workspace, env, _, versions_log, _, _ = launcher_workspace
    keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
            "http_proxy", "https_proxy", "all_proxy", "no_proxy",
            "OPENCODE_HTTP_PROXY", "OPENCODE_HTTPS_PROXY"]
    env.update({key: "inherited-proxy" for key in keys})
    flags = ["--proxy=first", "--disable-proxy"]
    if enable_again:
        flags += ["--http-proxy=last"]
    subprocess.run(["sh", str(workspace / "start.sh"), *flags], env=env, check=True)
    settings = dict(line.split("=", 1) for line in Path(f"{versions_log}.env").read_text().splitlines())
    for key in keys:
        assert settings[key] == ("last" if enable_again and key == "OPENCODE_HTTP_PROXY" else "")


def test_launcher_defaults_leave_dotenv_overrides_to_compose(launcher_workspace):
    workspace, env, args_log, versions_log, _, _ = launcher_workspace
    host_config = Path(env["HOME"]) / ".config/opencode"
    host_config.mkdir(parents=True)
    subprocess.run(
        ["sh", str(workspace / "start.sh"), "--build", "--no-build"], env=env, check=True,
    )
    settings = dict(line.split("=", 1) for line in Path(f"{versions_log}.env").read_text().splitlines())
    assert settings["OPENCODE_CONFIG_SOURCE"] == "<unset>"
    assert settings["OPENCODE_IMAGE"] == "<unset>"
    assert versions_log.read_text().splitlines()[-1] == str(host_config)
    assert len(launcher_calls(args_log)) == 1


def test_launcher_accepts_explicit_empty_proxy_values(launcher_workspace):
    workspace, env, _, versions_log, _, _ = launcher_workspace
    env.update(OPENCODE_HTTP_PROXY="inherited", NO_PROXY="inherited")
    subprocess.run(
        ["sh", str(workspace / "start.sh"), "--http-proxy=", "--no-proxy", ""],
        env=env, check=True,
    )
    settings = dict(line.split("=", 1) for line in Path(f"{versions_log}.env").read_text().splitlines())
    assert settings["OPENCODE_HTTP_PROXY"] == ""
    assert settings["NO_PROXY"] == ""
