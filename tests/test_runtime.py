"""Focused checks for config mirroring and the host launcher; no daemon needed."""

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


@pytest.mark.parametrize("build", [False, True])
def test_launcher_keeps_overrides_versions_and_paths_with_spaces(tmp_path, build):
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
    docker = tools / "docker"
    docker.write_text(
        '#!/bin/sh\n'
        'printf "%s\\000" "$@" > "$ARGS_LOG"\n'
        'printf "%s\\n" "$BUN_VERSION" "$OPENCODE_CONFIG_SOURCE" > "$VERSIONS_LOG"\n'
    )
    docker.chmod(0o755)
    env = os.environ.copy()
    env.update(
        PATH=f"{tools}:{env['PATH']}",
        ARGS_LOG=str(args_log),
        VERSIONS_LOG=str(versions_log),
        BUN_VERSION="9.8.7",
        HOME=str(tmp_path / "home"),
    )
    env.pop("OPENCODE_CONFIG_SOURCE", None)
    command = ["sh", str(workspace / "start.sh")]
    if build:
        command.append("--build")
    subprocess.run(command, cwd=tmp_path, env=env, check=True)

    args = args_log.read_bytes().decode().rstrip("\0").split("\0")
    assert args[:3] == ["compose", "--project-directory", str(workspace)]
    if build:
        assert args[3:9] == [
            "-f", str(workspace / "compose.yaml"),
            "-f", str(workspace / "compose.build.yaml"),
            "-f", str(workspace / "compose.override.yaml"),
        ]
        assert args[9:] == ["up", "-d", "--build"]
    else:
        assert args[3:] == ["up", "-d"]
    assert versions_log.read_text().splitlines() == [
        "9.8.7", str(workspace / "config" / "opencode")
    ]
