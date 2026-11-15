"""Execute release validation from the workflow and check publication ordering."""

import os
from pathlib import Path
import subprocess
import textwrap

import pytest


WORKFLOW = (Path(__file__).resolve().parents[1] / ".github/workflows/publish-runtime.yml").read_text()


@pytest.mark.parametrize("version,stable", [
    ("0.0.0", True), ("12.30.400", True),
    ("1.2.3-rc.1", False), ("1.2.3-0", False), ("1.2.3-01a", False),
    ("latest", None), ("local", None), ("1.2", None), ("v1.2.3", None),
    ("01.2.3", None), ("1.2.3-01", None), ("1.2.3-rc..1", None),
    ("1.2.3+build", None), ("1.2.3-", None), ("1.2.3\ninjected", None),
    ("1.2.3-" + "a" * 82, None),
])
@pytest.mark.parametrize("event", ["push", "workflow_dispatch"])
def test_release_version_validation(tmp_path, version, stable, event):
    step = WORKFLOW.split("      - name: Derive and validate the version tag\n", 1)[1]
    script = textwrap.dedent(step.split("        run: |\n", 1)[1].split("\n      - name:", 1)[0])
    output = tmp_path / "outputs"
    result = subprocess.run(
        ["bash", "-eu", "-c", script], text=True, capture_output=True,
        env={**os.environ, "VERSION_INPUT": version, "GITHUB_EVENT_NAME": event,
             "GITHUB_REF_NAME": f"runtime-v{version}", "GITHUB_OUTPUT": str(output),
             "IMAGE": "example/runtime"},
    )
    if stable is None:
        assert result.returncode != 0
        assert not output.exists()
    else:
        assert result.returncode == 0, result.stderr
        assert output.read_text().splitlines() == [f"stable={str(stable).lower()}", f"tag={version}"]


def test_latest_publication_follows_checks_and_versioned_pushes():
    publish = WORKFLOW.index("      - name: Push the tested image")
    latest = WORKFLOW.index("      - name: Update latest to the tested stable release")
    assert publish < latest
    for check in ("Validate shell syntax", "Check configuration mirroring and launcher arguments",
                  "Validate the Compose files", "Test the chat memory plugin",
                  "Smoke test an already-unprivileged process"):
        assert WORKFLOW.index(f"      - name: {check}") < publish
    assert 'docker push "${IMAGE}:${{ steps.version.outputs.tag }}"' in WORKFLOW[publish:latest]
    assert 'docker push "${IMAGE}:${{ steps.version.outputs.tag }}-${{ github.sha }}"' in WORKFLOW[publish:latest]
    latest_step = WORKFLOW[latest:].split("\n      - name:", 1)[0]
    assert "if: steps.version.outputs.stable == 'true'" in latest_step
    assert 'docker tag "${SMOKE_IMAGE}" "${IMAGE}:latest"' in latest_step
    assert 'docker push "${IMAGE}:latest"' in latest_step
