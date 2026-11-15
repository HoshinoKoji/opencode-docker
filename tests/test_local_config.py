"""Keep personal root preferences out of Git and the runtime build context."""

from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_personal_config_git_ignore_is_root_scoped(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    shutil.copyfile(ROOT / ".gitignore", tmp_path / ".gitignore")
    paths = [
        "opencode.json", "opencode.jsonc", "opencode.example.jsonc",
        "config/opencode/opencode.jsonc", "config/chat/opencode.jsonc",
        "nested/opencode.json", "nested/opencode.jsonc",
    ]
    result = subprocess.run(
        ["git", "check-ignore", "--stdin"], cwd=tmp_path,
        input="\n".join(paths) + "\n", text=True, capture_output=True, check=True,
    )
    assert result.stdout.splitlines() == ["opencode.json", "opencode.jsonc"]


def test_personal_config_build_exclusions_are_root_scoped():
    # Exact anchored rules exclude local preferences while retaining the baked
    # config/opencode and config/chat documents and the shareable template.
    rules = (ROOT / ".dockerignore").read_text().splitlines()
    config_rules = [rule for rule in rules if "opencode.json" in rule]
    assert config_rules == ["/opencode.json", "/opencode.jsonc"]
