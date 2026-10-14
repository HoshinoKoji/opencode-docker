"""Version smoke checks exercise the same script used by the publish workflow."""

import os
from pathlib import Path
import shlex
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "docker/smoke-tools.sh"
OUTPUTS = {
    "opencode": "opencode v2.0.28",
    "node": "v24.15.0",
    "bun": "1.3.14",
    "uv": "uv 0.12.23 (x86_64-unknown-linux-gnu)",
    "cargo": "cargo 1.99.0 (5f94df478 2026-08-27)",
    "rustc": "rustc 1.99.0 (b940084d7 2026-09-28)",
}


def run_smoke(tmp_path, overrides=None, failure=None, version="2.0.28"):
    tools = tmp_path / "bin"
    tools.mkdir()
    for name, output in (OUTPUTS | (overrides or {})).items():
        tool = tools / name
        tool.write_text(
            "#!/bin/sh\n"
            f"printf '%s\\n' {shlex.quote(output)}\n"
            f"exit {9 if failure == name else 0}\n"
        )
        tool.chmod(0o755)
    env = os.environ.copy()
    env.update(
        PATH=f"{tools}:{env['PATH']}",
        OPENCODE_VERSION=version,
        NODE_VERSION="24.15.0",
        BUN_VERSION="1.3.14",
        UV_VERSION="0.12.23",
        RUST_VERSION="1.99.0",
    )
    return subprocess.run(["sh", str(SMOKE)], env=env, text=True, capture_output=True)


@pytest.mark.parametrize("version,output", [
    ("2.0.28", "opencode v2.0.28"),
    ("1.18.35", "1.18.35"),
])
def test_smoke_accepts_v1_and_v2_version_output(tmp_path, version, output):
    result = run_smoke(tmp_path, {"opencode": output}, version=version)
    assert result.returncode == 0, result.stderr
    assert result.stdout.count("version OK") == 6


@pytest.mark.parametrize("tool", list(OUTPUTS))
def test_smoke_reports_version_mismatch(tmp_path, tool):
    result = run_smoke(tmp_path, {tool: "wrong-version"})
    assert result.returncode != 0
    assert "version mismatch" in result.stderr
    assert "expected [" in result.stderr
    assert "got [wrong-version]" in result.stderr


@pytest.mark.parametrize("tool,output", [
    ("opencode", "opencode v2.0.280"),
    ("opencode", "opencode v2.0.28 extra"),
    ("uv", "uv 0.12.230"),
    ("cargo", "cargo 1.99.00"),
    ("rustc", "rustc 1.99.00"),
])
def test_smoke_rejects_partial_version_matches(tmp_path, tool, output):
    result = run_smoke(tmp_path, {tool: output})
    assert result.returncode != 0
    assert "version mismatch" in result.stderr


@pytest.mark.parametrize("tool", list(OUTPUTS))
def test_smoke_rejects_failed_command_even_with_expected_output(tmp_path, tool):
    result = run_smoke(tmp_path, failure=tool)
    assert result.returncode == 9
    assert result.stdout.count("version OK") == list(OUTPUTS).index(tool)
