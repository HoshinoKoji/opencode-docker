"""Focused checks for installation, config mirroring, and launching; no daemon needed."""

import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

import pytest


ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = ROOT / "docker" / "entrypoint.sh"
INSTALLER = ROOT / "docker" / "install-opencode.sh"


def test_rust_permissions_are_prepared_before_copying_into_runtime():
    instructions = [
        line.strip() for line in (ROOT / "Dockerfile").read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    rust_start = instructions.index("FROM rust:${RUST_VERSION}-bookworm AS rust")
    runtime_start = instructions.index("FROM ubuntu:24.04")
    chmod = "RUN chmod -R a+rX,go-w /usr/local/rustup /usr/local/cargo"
    assert chmod in instructions[rust_start + 1:runtime_start]
    runtime = instructions[runtime_start + 1:]
    for directory in ("/usr/local/rustup", "/usr/local/cargo"):
        assert f"COPY --from=rust {directory} {directory}" in runtime
        assert not any("chmod" in line and directory in line for line in runtime)


@pytest.mark.parametrize("version", ["1.18.35", "2.0.28"])
@pytest.mark.parametrize("architecture,target", [
    ("amd64", "linux-x64-baseline"),
    ("arm64", "linux-arm64"),
])
@pytest.mark.parametrize("failure", [None, "download", "archive"])
def test_opencode_installer_uses_pinned_native_packages(tmp_path, version, architecture, target, failure):
    archive = tmp_path / "source.tgz"
    member = "opencode" if version.startswith("1.") else "package/bin/opencode"
    binary = f"#!/bin/sh\nprintf '%s\\n' '{version}'\n".encode()
    with tarfile.open(archive, "w:gz") as contents:
        entry = tarfile.TarInfo(member)
        entry.size = len(binary)
        entry.mode = 0o755
        contents.addfile(entry, io.BytesIO(binary))

    tools = tmp_path / "bin"
    tools.mkdir()
    curl = tools / "curl"
    curl.write_text(
        '#!/bin/sh\n'
        'printf "%s\\n" "$@" > "$CURL_LOG"\n'
        'if [ "$FAILURE" = download ]; then exit 22; fi\n'
        'while [ "$#" -gt 0 ]; do\n'
        '  if [ "$1" = -o ]; then\n'
        '    if [ "$FAILURE" = archive ]; then printf broken > "$2";\n'
        '    else cp "$SOURCE_ARCHIVE" "$2"; fi\n'
        '    exit 0\n'
        '  fi\n'
        '  shift\n'
        'done\n'
        'exit 1\n'
    )
    curl.chmod(0o755)
    temporary = tmp_path / "temporary"
    temporary.mkdir()
    destination = tmp_path / "opencode"
    destination.write_text("previous binary")
    env = os.environ.copy()
    env.update(
        PATH=f"{tools}:{env['PATH']}",
        CURL_LOG=str(tmp_path / "curl-log"),
        SOURCE_ARCHIVE=str(archive),
        TMPDIR=str(temporary),
        FAILURE=failure or "",
    )
    result = subprocess.run(
        ["sh", str(INSTALLER), version, architecture, str(destination)],
        env=env, text=True, capture_output=True,
    )
    if version.startswith("1."):
        expected_url = f"https://github.com/anomalyco/opencode/releases/download/v{version}/opencode-{target}.tar.gz"
    else:
        expected_url = f"https://registry.npmjs.org/@opencode/cli-{target}/-/cli-{target}-{version}.tgz"
    assert expected_url in (tmp_path / "curl-log").read_text().splitlines()
    assert not list(temporary.iterdir())
    if failure:
        assert result.returncode != 0
        assert destination.read_text() == "previous binary"
    else:
        assert result.returncode == 0, result.stderr
        assert destination.read_bytes() == binary
        assert destination.stat().st_mode & 0o777 == 0o755
        assert subprocess.check_output([str(destination)], text=True).strip() == version


@pytest.mark.parametrize("version,architecture", [("3.0.0", "amd64"), ("2.0.28", "s390x")])
def test_opencode_installer_rejects_unsupported_targets(tmp_path, version, architecture):
    destination = tmp_path / "opencode"
    result = subprocess.run(
        ["sh", str(INSTALLER), version, architecture, str(destination)],
        text=True, capture_output=True,
    )
    assert result.returncode != 0
    assert "unsupported" in result.stderr
    assert not destination.exists()


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
        'printf "%s\\n" "$BUN_VERSION" "$OPENCODE_VERSION" "$OPENCODE_CONFIG_SOURCE" > "$VERSIONS_LOG"\n'
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
@pytest.mark.parametrize("opencode_override", [None, "1.18.35"])
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
        "9.8.7", opencode_override or "2.0.28", str(workspace / "config" / "opencode")
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
        ["sh", str(workspace / "start.sh"), "--wait", "--build=true", "--timeout", "60", "opencode"],
        cwd=tmp_path, env=env, check=True,
    )
    calls = launcher_calls(args_log)
    assert calls[-1][-7:] == ["up", "-d", "--no-build", "--wait", "--timeout", "60", "opencode"]
    assert "--build=true" not in calls[-1]
