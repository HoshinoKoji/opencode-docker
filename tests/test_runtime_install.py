"""Exercise the runtime installer with fake Bun/native tools; no network/daemon."""

import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def runtime(tmp_path):
    tools = tmp_path / "tools"
    tools.mkdir()
    launcher = tools / "opencode"
    shutil.copy(ROOT / "docker/opencode.sh", launcher)
    launcher.chmod(0o755)
    bun = tools / "bun"
    bun.write_text('''#!/bin/sh
set -eu
echo "$*" >> "$INSTALL_LOG"
[ "${OFFLINE:-0}" = 0 ] || exit 90
[ "$1 $2 $3" = 'install -g --trust' ] || exit 91
version=${4##*@}
mkdir -p "$BUN_INSTALL/bin" "$BUN_INSTALL/package"
sleep "${INSTALL_DELAY:-0}"
[ "${INSTALL_FAIL:-0}" = 0 ] || exit 92
printf '#!/bin/sh\n' > "$BUN_INSTALL/package/native"
printf 'if [ "${1:-}" = --version ]; then echo "opencode v%s"; exit 0; fi\n' "${ACTUAL_VERSION:-$version}" >> "$BUN_INSTALL/package/native"
cat >> "$BUN_INSTALL/package/native" <<'EOF'
printf '<%s>\\n' "$@"
[ "${CHECK_EXEC:-0}" = 0 ] || echo "pid=$$"
exit "${CLI_EXIT:-0}"
EOF
chmod 755 "$BUN_INSTALL/package/native"
# Deliberately absolute: the published cache must survive stage renaming.
ln -s "$BUN_INSTALL/package/native" "$BUN_INSTALL/bin/opencode"
''')
    bun.chmod(0o755)
    home = tmp_path / "custom home"
    env = {
        **os.environ,
        "PATH": f"{tools}:/usr/bin:/bin",
        "HOME": str(home),
        "OPENCODE_HOME": str(home),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "CARGO_HOME": str(home / ".cargo"),
        "OPENCODE_VERSION": "2.3.2",
        "OPENCODE_DEFAULT_VERSION": "",
        "OPENCODE_CONFIG_INPUT": str(tmp_path / "no-config"),
        "OPENCODE_AUTH_INPUT": str(tmp_path / "no-auth"),
        "OPENCODE_UID": str(os.getuid()),
        "OPENCODE_GID": str(os.getgid()),
        "INSTALL_LOG": str(tmp_path / "installs"),
    }
    env.pop("OPENCODE_PROFILE_INPUT", None)
    return launcher, env, home / ".local/share/opencode/runtime"


def invoke(runtime, *args, **overrides):
    launcher, env, _ = runtime
    return subprocess.run([str(launcher), *args], env=env | overrides,
                          text=True, capture_output=True, timeout=15)


def installs(runtime):
    log = Path(runtime[1]["INSTALL_LOG"])
    return log.read_text().splitlines() if log.exists() else []


def test_cold_warm_upgrade_and_rollback(runtime):
    assert invoke(runtime, "--version").stdout == "opencode v2.3.2\n"
    warm = invoke(runtime, "--version", OFFLINE="1")
    assert warm.returncode == 0, warm.stderr
    assert len(installs(runtime)) == 1
    assert invoke(runtime, "--version", OPENCODE_VERSION="2.4.0").stdout == "opencode v2.4.0\n"
    assert invoke(runtime, "--version", OFFLINE="1").returncode == 0
    assert len(installs(runtime)) == 2
    assert len(list(runtime[2].rglob("verified"))) == 2
    assert not list(runtime[2].rglob(".stage-*"))


@pytest.mark.parametrize("version", ["", "latest", "^2.3.2", "2", "1.2.3", "3.0.0",
                                      "2.03.2", "2.3.2-rc.1", "../../escape", "2.3.2\nbad"])
def test_invalid_pin_never_installs(runtime, version):
    result = invoke(runtime, "--version", OPENCODE_VERSION=version)
    assert result.returncode != 0
    assert "exact stable V2" in result.stderr
    assert installs(runtime) == []
    assert not runtime[2].exists()


def test_image_fallback(runtime):
    result = invoke(runtime, "--version", OPENCODE_VERSION="", OPENCODE_DEFAULT_VERSION="2.3.2")
    assert result.returncode == 0, result.stderr


def test_abandoned_stage_is_not_a_cache_hit_and_is_cleaned(runtime):
    assert invoke(runtime, "--version").returncode == 0
    marker = next(runtime[2].rglob("verified"))
    abandoned = marker.parent.parent / ".stage-2.4.0-abandoned"
    abandoned.mkdir()
    (abandoned / "partial").write_text("interrupted download")
    assert invoke(runtime, "--version", OFFLINE="1").returncode == 0
    assert not abandoned.exists()
    assert len(installs(runtime)) == 1


@pytest.mark.parametrize("failure", [{"INSTALL_FAIL": "1"}, {"OFFLINE": "1"},
                                     {"ACTUAL_VERSION": "2.3.1"}])
def test_failed_install_never_publishes_or_falls_back(runtime, failure):
    assert invoke(runtime, "--version").returncode == 0
    result = invoke(runtime, "--version", OPENCODE_VERSION="2.4.0", **failure)
    assert result.returncode != 0
    assert "opencode-runtime:" in result.stderr
    assert not list(runtime[2].rglob("2.4.0"))
    assert not list(runtime[2].rglob(".stage-*"))
    assert invoke(runtime, "--version", OFFLINE="1").returncode == 0
    assert invoke(runtime, "--version", OPENCODE_VERSION="2.4.0").returncode == 0


@pytest.mark.parametrize("corruption", ["binary", "marker", "missing", "symlink"])
def test_untrusted_cache_is_replaced(runtime, corruption):
    assert invoke(runtime, "--version").returncode == 0
    marker = next(runtime[2].rglob("verified"))
    binary = marker.parent / "opencode"
    if corruption == "binary":
        binary.write_text("#!/bin/sh\necho wrong\n")
    elif corruption == "marker":
        marker.write_text("2.3.1 untrusted")
    elif corruption == "missing":
        marker.unlink()
    else:
        binary.rename(binary.with_name("old"))
        binary.symlink_to("old")
    assert invoke(runtime, "--version", OFFLINE="1").returncode != 0
    result = invoke(runtime, "--version")
    assert result.returncode == 0, result.stderr
    assert result.stdout == "opencode v2.3.2\n"


def test_concurrent_cold_starts_install_once(runtime):
    launcher, env, _ = runtime
    processes = [subprocess.Popen([str(launcher), "--version"], env=env | {"INSTALL_DELAY": "0.2"},
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                 for _ in range(5)]
    for process in processes:
        out, err = process.communicate(timeout=15)
        assert process.returncode == 0, err
        assert out == "opencode v2.3.2\n"
    assert len(installs(runtime)) == 1


def test_exec_preserves_arguments_pid_and_exit_status(runtime):
    launcher, env, _ = runtime
    process = subprocess.Popen([str(launcher), "one two", "", "--flag"],
                               env=env | {"CLI_EXIT": "23", "CHECK_EXEC": "1"},
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = process.communicate(timeout=15)
    assert process.returncode == 23, err
    assert out == f"<one two>\n<>\n<--flag>\npid={process.pid}\n"


def test_entrypoint_passthrough_and_custom_home(runtime):
    _, env, _ = runtime
    result = subprocess.run(["sh", str(ROOT / "docker/entrypoint.sh"), "sh", "-c",
                             'printf "%s" "$1"', "sh", "argument with spaces"],
                            env=env | {"OFFLINE": "1"}, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout == "argument with spaces"
    assert installs(runtime) == []
    result = subprocess.run(["sh", str(ROOT / "docker/entrypoint.sh"), "opencode", "--version"],
                            env=env, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout == "opencode v2.3.2\n"
    assert next(runtime[2].rglob("verified")).stat().st_uid == os.getuid()
