import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ExternalMemoryStore } from "./policy.js";

const launcher = path.resolve(import.meta.dir, "../../..", "memory-mcp.sh");
const directories = [];
const clients = [];
const record = { topic: "mcp-test", goal: "Share memory", conclusion: "Saved", details: "中文 discussion", requestId: "stable-request" };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-mcp-test-"));
  directories.push(root);
  await mkdir(path.join(root, ".sessions/casual"), { recursive: true });
  await writeFile(path.join(root, ".sessions/MEMORY.md"), "# Shared\nshared-marker\n");
  await writeFile(path.join(root, ".sessions/casual/MEMORY.md"), "# Private\nprivate-marker\n");
  return root;
}
async function connect(root, args = [], env = {}) {
  const client = new Client({ name: "memory-integration-test", version: "1.0.0" });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: launcher, args, cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, MEMORY_ROOT: root, ...env }, stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (data) => { diagnostics += data; });
  await client.connect(transport);
  expect(client.getServerVersion().name).toBe("workspace-memory");
  return { client, diagnostics: () => diagnostics };
}
const call = (client, name, args = {}) => client.callTool({ name: `memory_${name}`, arguments: args });
async function result(client, name, args) {
  const response = await call(client, name, args);
  expect(response.isError).not.toBe(true);
  const value = JSON.parse(response.content[0].text);
  expect(response.structuredContent).toEqual(value);
  return value;
}
async function denied(client, name, args) {
  // Unknown/hidden tools may be rejected at the protocol level, while validation
  // and operation errors may be CallToolResult.isError, depending on SDK era.
  let response;
  try { response = await call(client, name, args); }
  catch (error) { expect(error.message).toMatch(/tool|scope|input|argument|valid/i); return; }
  expect(response.isError).toBe(true);
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});

test("stdio initialize/list/call defaults to shared and cannot expose private data", async () => {
  const root = await fixture();
  const { client, diagnostics } = await connect(root);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "memory_recall", "memory_search", "memory_read", "memory_record", "memory_update",
  ]);
  expect(JSON.stringify(await result(client, "recall"))).not.toContain("private-marker");
  expect((await result(client, "search", { query: "private-marker" })).matches).toBe(0);
  expect((await result(client, "read", { name: "MEMORY.md" })).results).toHaveLength(1);
  for (const scope of ["private", "both"]) {
    for (const [name, input] of [["recall", {}], ["search", { query: "private-marker" }], ["read", { name: "MEMORY.md" }], ["record", record]]) {
      const response = await call(client, name, { ...input, scope });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain("private-marker");
    }
  }
  await denied(client, "read", { name: ".sessions/casual/MEMORY.md" });
  await denied(client, "recall", { agent: "casual" });
  expect(await readFile(path.join(root, ".sessions/casual/MEMORY.md"), "utf8")).toContain("private-marker");
  expect(await readdir(path.join(root, ".sessions/casual"))).toEqual(["MEMORY.md"]);
  expect(diagnostics()).toBe("");
});

test("records retry across renamed dates, reject changed retries, page reads and enforce revisions", async () => {
  const root = await fixture();
  const { client } = await connect(root);
  const saved = await result(client, "record", record);
  await rename(path.join(root, saved.path), path.join(root, ".sessions/2000-01-01-renamed.md"));
  const retry = await result(client, "record", record);
  expect(retry.id).toBe(saved.id);
  expect(retry.name).toBe("2000-01-01-renamed.md");
  await denied(client, "record", { ...record, details: "changed" });
  const page = (await result(client, "read", { name: retry.name, offset: 5, limit: 7 })).results[0];
  expect(page.text).toHaveLength(7);
  expect(page.truncated).toBe(true);
  expect(page.offset).toBe(5);
  const before = (await result(client, "read", { name: "MEMORY.md" })).results[0];
  const input = { content: "# Shared\nMerged preference", expectedRevision: before.revision };
  await result(client, "update", input);
  const raw = await readFile(path.join(root, ".sessions/MEMORY.md"), "utf8");
  await denied(client, "update", input);
  expect(await readFile(path.join(root, ".sessions/MEMORY.md"), "utf8")).toBe(raw);
  expect((await result(client, "read", { name: "MEMORY.md" })).results[0].metadata.type).toBe("long_term");
});

test("private/both opt-in, explicit write scope, and root flag overrides environment", async () => {
  const root = await fixture();
  const other = await fixture();
  const { client: privateClient } = await connect(other, ["--root", root, "--space=private"]);
  expect((await result(privateClient, "recall")).spaces.map((s) => s.scope)).toEqual(["private"]);
  expect((await result(privateClient, "record", record)).scope).toBe("private");
  await denied(privateClient, "record", { ...record, scope: "shared" });
  await denied(privateClient, "recall", { scope: "shared" });
  expect(await readdir(path.join(other, ".sessions/casual"))).toEqual(["MEMORY.md"]);
  const { client } = await connect(root, ["--space", "both"]);
  expect((await result(client, "recall")).spaces).toHaveLength(2);
  expect((await result(client, "search", { query: "private-marker" })).results[0].scope).toBe("private");
  await denied(client, "record", record);
  await denied(client, "record", { ...record, scope: "both" });
  for (const scope of ["shared", "private"]) expect((await result(client, "record", { ...record, scope })).scope).toBe(scope);
});

test("read-only hides writes and denies direct calls and store mutations", async () => {
  const root = await fixture();
  const { client } = await connect(root, ["--read-only", "--space=both"]);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["memory_recall", "memory_search", "memory_read"]);
  const before = (await result(client, "read", { name: "MEMORY.md" })).results;
  for (const scope of ["shared", "private", "both"]) {
    await denied(client, "record", { ...record, scope });
    await denied(client, "update", { scope, content: "changed", expectedRevision: before[0].revision });
  }
  const store = new ExternalMemoryStore(root, { space: "both", readOnly: true });
  await expect(store.record(null, { ...record, scope: "shared" }, "direct")).rejects.toThrow("read-only");
  await expect(store.update(null, { scope: "private", content: "changed" })).rejects.toThrow("read-only");
  expect((await result(client, "read", { name: "MEMORY.md" })).results).toEqual(before);
  expect(await readdir(path.join(root, ".sessions"))).toEqual(["MEMORY.md", "casual"]);
});

test("strict schemas reject invalid calls and memory symlinks cannot cross scope", async () => {
  const root = await fixture();
  const { client } = await connect(root);
  for (const [name, args] of [
    ["search", { query: "   " }], ["search", { query: "x", limit: 21 }],
    ["read", { name: "MEMORY.md", offset: -1 }], ["read", { name: "../MEMORY.md" }],
    ["read", { name: "MEMORY.md", limit: 1.5 }],
    ["record", { ...record, requestId: "" }], ["record", { ...record, requestId: undefined }],
    ["record", { ...record, details: 12 }], ["record", { ...record, share: true }],
    ["record", { ...record, topic: "../escape" }], ["update", { content: "missing revision" }],
  ]) await denied(client, name, args);
  await rm(path.join(root, ".sessions/MEMORY.md"));
  await symlink(path.join(root, ".sessions/casual/MEMORY.md"), path.join(root, ".sessions/MEMORY.md"));
  const response = await call(client, "read", { name: "MEMORY.md" });
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response)).not.toContain("private-marker");
  expect(await readdir(path.join(root, ".sessions"))).toEqual(["MEMORY.md", "casual"]);
});

test("launcher validates arguments, explicit root, and keeps help/errors off stdout", async () => {
  const root = await fixture();
  const run = (args, env = {}) => spawnSync(launcher, args, {
    env: { PATH: process.env.PATH, ...env }, cwd: root, encoding: "utf8", timeout: 10000,
  });
  for (const args of [[], ["--space=invalid"], ["--root"], ["--root="], ["--read-only=false"], ["--agent=casual"], ["positional"], ["--root", "--space=both"]]) {
    const output = run(args);
    expect(output.status).toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("memory-mcp:");
  }
  const help = run(["--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toBe("");
  expect(help.stderr).toContain("Usage:");
  const missing = run(["--root", path.join(root, "missing")]);
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
  const noBun = run([], { PATH: "/usr/bin:/bin" });
  expect(noBun.status).toBe(1);
  expect(noBun.stderr).toContain("Bun");
  // A fresh checkout must explain the one-time install, never install itself.
  const copy = path.join(root, "memory-mcp.sh");
  await writeFile(copy, await readFile(launcher), { mode: 0o755 });
  const missingDependencies = spawnSync(copy, ["--root", root], {
    env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000,
  });
  expect(missingDependencies.status).toBe(1);
  expect(missingDependencies.stdout).toBe("");
  expect(missingDependencies.stderr).toContain("bun install --cwd");
  expect(missingDependencies.stderr).toContain("--frozen-lockfile");
  expect(await readdir(root)).not.toContain("config");
});
