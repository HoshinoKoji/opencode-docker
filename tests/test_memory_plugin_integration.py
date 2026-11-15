"""Load the real chat profile in an isolated OpenCode server, without an LLM."""

import base64
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(shutil.which("opencode") is None, reason="OpenCode CLI is not installed")
def test_chat_memory_plugin_loads_with_real_opencode(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    profile = tmp_path / "profile"
    shutil.copytree(ROOT / "config/chat", profile)
    config = profile / "opencode.jsonc"
    config.write_text(config.read_text().replace("/home/bun/workspace", str(workspace)))
    home = tmp_path / "home"
    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("OPENCODE", "XDG_"))
    }
    env.update(
        HOME=str(home), OPENCODE_HOME=str(home),
        XDG_CONFIG_HOME=str(home / ".config"),
        XDG_DATA_HOME=str(home / ".local/share"),
        XDG_CACHE_HOME=str(home / ".cache"),
        XDG_STATE_HOME=str(home / ".local/state"),
        OPENCODE_UID=str(os.getuid()), OPENCODE_GID=str(os.getgid()),
        OPENCODE_CONFIG_INPUT=str(ROOT / "config/opencode"),
        OPENCODE_PROFILE_INPUT=str(profile),
        OPENCODE_AUTH_INPUT=str(tmp_path / "no-auth"),
        CARGO_HOME=str(home / ".cargo"),
        OPENCODE_SERVER_USERNAME="opencode", OPENCODE_SERVER_PASSWORD="isolated-test-password",
    )
    # A test-only plugin reads the registered catalog after the memory plugin.
    # It writes only to this test's temporary workspace.
    probe = tmp_path / "probe"
    probe.mkdir()
    (probe / "index.js").write_text(
        'import { writeFile } from "node:fs/promises";\n'
        f'import {{ decode, encode }} from {json.dumps((profile / "memory-plugin/format.js").as_uri())};\n'
        'export default { id: "memory-catalog-probe", async setup(ctx) {\n'
        ' const doc = {schema_version:1,id:"test",type:"session",date:"2000-01-01",topic:"test",summary:"中文: YAML",created_at:"2000-01-01T00:00:00Z",updated_at:"2000-01-01T00:00:00Z"};\n'
        ' if (decode(encode(doc,"body")).metadata.summary !== doc.summary) throw new Error("Native YAML unavailable");\n'
        ' const tools = (await ctx.tool.list()).filter(t => t.id.startsWith("memory_"));\n'
        ' await writeFile(ctx.options.output, JSON.stringify(tools.map(t => ({id:t.id,input:t.input}))));\n'
        '} };\n'
    )
    catalog = workspace / "catalog.json"
    (workspace / "opencode.json").write_text(json.dumps({
        "plugins": [{"package": str(probe), "options": {"output": str(catalog)}}],
    }))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    auth = base64.b64encode(b"opencode:isolated-test-password").decode()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(route):
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{route}", headers={"Authorization": f"Basic {auth}"},
        )
        with opener.open(request, timeout=3) as response:
            return json.load(response)

    with (tmp_path / "server.log").open("w+") as log:
        server = subprocess.Popen(
            ["sh", str(ROOT / "docker/entrypoint.sh"), "opencode", "serve",
             "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=workspace, env=env, stdout=log, stderr=log,
        )
        try:
            deadline = time.monotonic() + 30
            plugins = []
            while time.monotonic() < deadline:
                assert server.poll() is None, "OpenCode exited before plugin startup"
                try:
                    plugins = get("/api/plugin")["data"]
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.1)
                    continue
                active = {item.get("id") for item in plugins if item["state"]["status"] == "active"}
                if {"workspace-memory", "memory-catalog-probe"} <= active:
                    break
                time.sleep(0.1)
            else:
                pytest.fail(f"Memory plugin failed to load: {plugins}")

            tools = json.loads(catalog.read_text())
            assert {tool["id"] for tool in tools} == {
                "memory_recall", "memory_search", "memory_read", "memory_record", "memory_update",
            }
            assert all("agent" not in tool["input"]["properties"] for tool in tools)
            for name, effect in (("serious", "allow"), ("casual", "allow"), ("temp", "deny")):
                agent = get(f"/api/agent/{name}")["data"]
                rules = [rule for rule in agent["permissions"] if rule["action"] == "memory_*"]
                assert rules[-1]["effect"] == effect
            # Evaluate the actual merged native V2 rules, including the global
            # deny and built-in overrides (last match wins).
            for name in ("build", "plan", "temp", "general", "explore"):
                agent = get(f"/api/agent/{name}")["data"]
                if name in ("build", "plan"):
                    assert not agent.get("system"), "Keep the provider's built-in coding prompt"
                for action in ("memory_recall", "memory_search", "memory_read", "memory_record", "memory_update"):
                    for resource in ("shared", "private", "both"):
                        matching = [rule for rule in agent["permissions"]
                                    if fnmatchcase(action, rule["action"])
                                    and fnmatchcase(resource, rule["resource"])]
                        allowed = resource == "shared" and (
                            name == "build" or name == "plan" and action in
                            ("memory_recall", "memory_search", "memory_read"))
                        assert matching[-1]["effect"] == ("allow" if allowed else "deny"), (name, action, resource)
            assert not (workspace / "MEMORY.md").exists()
            assert not (workspace / ".sessions/MEMORY.md").exists()
            assert not (workspace / ".sessions").exists()
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
