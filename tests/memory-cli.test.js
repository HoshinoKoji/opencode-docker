import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { SyncPrototype } from "../config/chat/memory-plugin/sync-prototype.js";

const wrapper = path.resolve(import.meta.dir, "../memory.sh");
const directories = [];
for (const schema of [1, 2]) test(`CLI v${schema} updates a section via JSON without changing siblings`, async () => {
  const { root, call } = await fixture();
  await mkdir(path.join(root, ".sessions"));
  await writeFile(path.join(root, ".sessions/MEMORY.md"), "# Memory\n## First\nold\n## Last\nkeep\n");
  expect(call(["import", "--source", root]).status).toBe(0);
  if (schema === 2) expect(call(["upgrade-sync"]).status).toBe(0);
  const read = JSON.parse(call(["read", "MEMORY.md", "--section", "First"]).stdout).results[0];
  const input = JSON.stringify({ section: "First", content: "## First\nnew", expectedRevision: read.revision });
  expect(call(["update", "--input=-"], input).status).toBe(0);
  const after = JSON.parse(call(["read", "MEMORY.md"]).stdout).results[0];
  expect(after.text).toBe("# Memory\n## First\nnew\n\n## Last\nkeep\n");
  expect(call(["update", "--input=-"], input).status).toBe(1);
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memory-cli-test-"));
  directories.push(directory);
  const root = path.join(directory, "memory with spaces");
  await mkdir(root);
  const env = { ...process.env, MEMORY_ROOT: root };
  const call = (args, input) => spawnSync("sh", [wrapper, ...args], {
    cwd: directory, env, input, encoding: "utf8", timeout: 10000,
  });
  return { root, directory, env, call };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const record = { topic: "cli-bridge", goal: "Share memory", conclusion: "Use the CLI", details: "中文内容 with 'quotes' and $shell syntax.\nSecond line." };

test("CLI progressive recall and section pagination", async () => {
  const { root, call } = await fixture();
  await writeFile(path.join(root, "MEMORY.md"), "# Memory\n## Summary\nbrief\n## Detail\nprivate-detail\n### Child\nnested\n## End\nstop\n");
  expect(call(["import", "--source", root]).status).toBe(0);
  const memory = JSON.parse(call(["recall"]).stdout).spaces[0].memory;
  expect(memory.text).toContain("brief");
  expect(memory.text).not.toContain("private-detail");
  const whole = JSON.parse(call(["read", "MEMORY.md"]).stdout).results[0];
  const selected = JSON.parse(call(["read", "MEMORY.md", "--section", "Detail"]).stdout).results[0];
  expect(selected.text).toContain("nested");
  expect(selected.text).not.toContain("stop");
  expect(selected.revision).toBe(whole.revision);
  const page = JSON.parse(call(["read", "MEMORY.md", "--section=Detail", "--offset=3", "--limit=5"]).stdout).results[0];
  expect(page.text).toBe(selected.text.slice(3, 8));
  expect(page.total).toBe(selected.total);
  expect(call(["read", "MEMORY.md", "--section=missing"]).stderr).toContain("Section not found");
  expect(call(["recall", "--section=Detail"]).status).toBe(2);
});

test("CLI help is side-effect free even with a nonexistent root", async () => {
  const { root, call } = await fixture();
  const result = call(["--root", "/does-not-exist", "record", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("expectedRevision");
  expect(result.stderr).toBe("");
  expect(await readdir(root)).toEqual([]);
});

for (const schema of [1, 2]) test(`CLI v${schema}: external cwd, root override, stdin and file writes, and explicit spaces`, async () => {
  const { root, directory, call } = await fixture();
  if (schema === 2) {
    expect(call(["init", "--space", "both"]).status).toBe(0);
    for (const scope of ["shared", "private"]) expect(call(["upgrade-sync", "--space", scope]).status).toBe(0);
  }
  const first = call(["record", "--input=-", "--request-id=stable-key"], JSON.stringify(record));
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  const saved = JSON.parse(first.stdout);
  expect(saved.logicalPath).toBe(`.sessions/${saved.name}`);
  expect(saved).not.toHaveProperty("path");
  expect(saved.scope).toBe("shared");
  expect(saved.requestId).toBe("stable-key");
  const inputFile = path.join(directory, "record input.json");
  await writeFile(inputFile, JSON.stringify({ ...record, details: "private-marker" }));
  expect(call(["record", "--space", "private", "--input", inputFile]).status).toBe(0);
  const shared = JSON.parse(call(["search", "private-marker"]).stdout);
  expect(shared.matches).toBe(0);
  const both = JSON.parse(call(["search", "private-marker", "--space=both"]).stdout);
  expect(both.results[0].scope).toBe("private");
  expect(JSON.parse(call(["recall", "--space=private"]).stdout).spaces.map((s) => s.scope)).toEqual(["private"]);
  expect(JSON.parse(call(["recall", "--space=both"]).stdout).spaces).toHaveLength(2);
  const page = JSON.parse(call(["read", saved.name, "--limit=10", "--offset", "5"]).stdout).results[0];
  expect(page.text.length).toBe(10);
  expect(page.truncated).toBe(true);
  expect(page.metadata.topic).toBe(record.topic);
  const other = path.join(directory, "other");
  await mkdir(other);
  const empty = JSON.parse(call(["recall", "--root", other]).stdout);
  expect(empty.spaces[0].recent).toEqual([]);
  expect(await readdir(other)).toEqual([]);
  expect(await readdir(root)).toContain(".memory-db");
});

test("stable request IDs retry records after a filename/date change without duplicates", async () => {
  const { root, call } = await fixture();
  const args = ["record", "--input", "-", "--request-id", "retry-key"];
  const first = JSON.parse(call(args, JSON.stringify(record)).stdout);
  const renamed = ".sessions/2000-01-01-renamed.md";
  const db = new Database(path.join(root, ".memory-db/shared.sqlite"));
  db.query("UPDATE documents SET name = ? WHERE name = ?").run(path.basename(renamed), first.name);
  db.close();
  const second = call(args, JSON.stringify(record));
  expect(second.status).toBe(0);
  expect(JSON.parse(second.stdout).logicalPath).toBe(renamed);
  expect(JSON.parse(second.stdout).id).toBe(first.id);
  expect(JSON.parse(call(["recall"]).stdout).spaces[0].recent).toHaveLength(1);
  const changed = call(args, JSON.stringify({ ...record, details: "Changed content" }));
  expect(changed.status).toBe(1);
  expect(changed.stdout).toBe("");
  expect(JSON.parse(changed.stderr).error.code).toBe("OPERATION_FAILED");
});

test("long-term JSON updates retain revisions and report conflicts on stderr", async () => {
  const { root, call } = await fixture();
  const previous = JSON.parse(call(["read", "MEMORY.md"]).stdout).results[0];
  const input = JSON.stringify({ content: "# Memory\nA lasting preference", expectedRevision: previous.revision });
  const updated = call(["update", "--input=-"], input);
  expect(updated.status).toBe(0);
  const raw = JSON.parse(call(["read", "MEMORY.md"]).stdout).results[0];
  expect(raw.metadata.type).toBe("long_term");
  const stale = call(["update", "--input=-"], input);
  expect(stale.status).toBe(1);
  expect(stale.stdout).toBe("");
  expect(JSON.parse(stale.stderr).error.message).toContain("Memory changed");
  expect(JSON.parse(call(["read", "MEMORY.md"]).stdout).results[0]).toEqual(raw);
});

test("CLI edits and deletes one named session in its selected space", async () => {
  const { call } = await fixture();
  const invoke = (name, payload) => call([name, "--space=private", "--input=-"], JSON.stringify(payload));
  const recordResult = invoke("record", record);
  expect(recordResult.status).toBe(0);
  const { name, revision, id, logicalPath } = JSON.parse(recordResult.stdout);
  const editResult = invoke("update", { name, content: "new CLI body", expectedRevision: revision });
  expect(editResult.status).toBe(0);
  const edit = JSON.parse(editResult.stdout);
  expect(edit.revision).not.toBe(revision);
  expect(call(["read", name]).stdout).not.toContain("new CLI body");
  expect(call(["read", name, "--space=private"]).stdout).toContain("new CLI body");
  const deletion = { name, expectedRevision: edit.revision };
  expect(invoke("delete", deletion).stderr).toContain("requires SQLite schema v2");
  expect(call(["upgrade-sync", "--space=private"]).status).toBe(0);
  expect(invoke("delete", { name, expectedRevision: revision }).stderr).toContain("Memory changed");
  for (const name of ["MEMORY.md", "INDEX.md", `../${deletion.name}`]) {
    expect(invoke("delete", { ...deletion, name }).stderr).toContain("session record filename");
  }
  const deleted = invoke("delete", deletion);
  expect(deleted.status).toBe(0);
  expect(JSON.parse(deleted.stdout)).toEqual({ scope: "private", name, logicalPath, id, deleted: true });
  expect(invoke("delete", deletion).status).toBe(1);
  expect(JSON.parse(call(["recall", "--space=private"]).stdout).spaces[0].recent).toEqual([]);
});

test("CLI conflict administration fails closed for absent or v1 spaces", async () => {
  const { root, call } = await fixture();
  const payload = JSON.stringify({ name: "MEMORY.md", expectedRevision: "1".repeat(64), conflictToken: "2".repeat(64), branchId: "left" });
  for (const [args, input] of [[["conflicts", "MEMORY.md"]], [["resolve", "--input=-"], payload]]) {
    expect(call(args, input).stderr).toContain("requires an existing SQLite schema v2");
  }
  expect(await readdir(root)).toEqual([]);
  expect(call(["init"]).status).toBe(0);
  const filename = path.join(root, ".memory-db/shared.sqlite");
  const before = await readFile(filename);
  for (const [args, input] of [[["conflicts", "MEMORY.md"]], [["resolve", "--input=-"], payload]]) {
    const failure = call(args, input);
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain("requires SQLite schema v2");
  }
  expect(await readFile(filename)).toEqual(before);
  expect((await readdir(path.dirname(filename))).filter((name) => name.includes(".v1-") || name.startsWith("private"))).toEqual([]);
});

test("CLI inspects exact scoped branches, resolves with a manual body, then inspects mixed tombstones", async () => {
  const { root, call } = await fixture();
  const run = (args, input) => call([...args, "--space=private"], input && JSON.stringify(input));
  expect(run(["init"]).status).toBe(0);
  expect(run(["upgrade-sync"]).status).toBe(0);
  const { name, id, logicalPath } = JSON.parse(run(["record", "--input=-"], record).stdout);
  const initial = JSON.parse(run(["read", name]).stdout).results[0];
  const db = new Database(path.join(root, ".memory-db/private.sqlite"));
  try {
    const sync = new SyncPrototype(db);
    const source = sync.view(id).raw;
    const rewrite = (idForOp, text) => sync.prepare({ id: idForOp, document: id, kind: "full", content: source.replace(record.details, text) });
    sync.push([rewrite("left", "left text"), rewrite("right", "right text")]);
    expect(call(["conflicts", name]).stderr).toContain("existing SQLite schema v2");
    expect(run(["conflicts", "2000-01-01-not-found.md"]).stderr).toContain("not found");
    const inspected = JSON.parse(run(["conflicts", name]).stdout);
    expect(inspected).toMatchObject({ scope: "private", name, logicalPath, id, revision: initial.revision,
      deleted: false, conflicts: [["left", "right"]] });
    expect(inspected.branches.map(({ raw }) => raw)).toEqual([source.replace(record.details, "left text"), source.replace(record.details, "right text")]);
    const guarded = { name, expectedRevision: inspected.revision, conflictToken: inspected.conflictToken };
    expect(run(["resolve", "--input=-"], { ...guarded, branchId: "missing" }).stderr).toContain("not an active conflict branch");
    const result = run(["resolve", "--input=-"], { ...guarded, content: "# Merged\nleft and right\n" });
    expect(result.status).toBe(0);
    const resolved = JSON.parse(result.stdout);
    expect(resolved).toMatchObject({ scope: "private", name, logicalPath, id });
    expect(resolved.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(resolved.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(run(["resolve", "--input=-"], { ...guarded, content: "# Merged\nleft and right\n" }).stderr).toContain("Conflict state changed");
    expect(JSON.parse(run(["read", name]).stdout).results[0]).toMatchObject({ text: "# Merged\nleft and right\n",
      metadata: initial.metadata, revision: resolved.revision });
    expect(JSON.parse(run(["conflicts", name]).stdout).branches).toEqual([]);
    expect(run(["resolve", "--input=-"], { name, expectedRevision: resolved.revision,
      conflictToken: JSON.parse(run(["conflicts", name]).stdout).conflictToken, content: "# Clean" }).stderr).toContain("requires active conflicts");
    expect(run(["update", "--input=-"], { name, expectedRevision: resolved.revision, content: "# Merged\npost-resolution edit\n" }).status).toBe(0);
    const deletion = sync.prepare({ id: "delete", document: id, kind: "delete" });
    const late = sync.prepare({ id: "late", document: id, kind: "full", content: sync.view(id).raw.replace("post-resolution edit", "offline edit") });
    sync.push([deletion, late]);
    const tombstone = JSON.parse(run(["conflicts", name]).stdout);
    expect(tombstone).toMatchObject({ deleted: true, conflicts: [["delete", "late"]] });
    expect(run(["resolve", "--input=-"], { name, expectedRevision: tombstone.revision, conflictToken: tombstone.conflictToken,
      branchId: "late" }).stderr).toContain("Tombstone recovery");
    expect(JSON.parse(run(["read", name]).stdout).results[0]).toMatchObject({ text: "", metadata: null });
  } finally { db.close(); }
});

test("invalid flags and JSON are rejected before any writes", async () => {
  const { root, call } = await fixture();
  const guarded = { name: "MEMORY.md", expectedRevision: "1".repeat(64), conflictToken: "2".repeat(64) };
  const invalid = [
    [["record"], ""],
    [["record", "--space=both", "--input=-"], JSON.stringify(record)],
    [["record", "--input=-"], "not-json"],
    [["record", "--input=-"], "[]"],
    [["record", "--input=-"], JSON.stringify({ ...record, scope: "private" })],
    [["record", "--input=-"], JSON.stringify({ ...record, nextSteps: 12 })],
    [["record", "--input=-"], JSON.stringify({ ...record, topic: "../escape" })],
    [["update", "--input=-"], '{"content":"Missing revision"}'],
    [["update", "--input=-"], '{"content":"x","expectedRevision":"r","summary":"not editable"}'],
    [["delete", "--input=-"], '{"name":"2000-01-01-topic.md"}'],
    [["delete", "--input=-"], '{"name":"2000-01-01-topic.md","expectedRevision":"r","section":"not allowed"}'],
    [["delete", "--space=both", "--input=-"], '{"name":"2000-01-01-topic.md","expectedRevision":"r"}'],
    [["conflicts", "--space=both", "MEMORY.md"], ""],
    [["conflicts", "../MEMORY.md"], ""],
    [["conflicts", "INDEX.md"], ""],
    [["resolve", "--input=-", "--space=both"], JSON.stringify({ ...guarded, branchId: "left" })],
    [["resolve", "--input=-"], JSON.stringify(guarded)],
    [["resolve", "--input=-"], JSON.stringify({ ...guarded, branchId: "left", content: "ambiguous" })],
    [["resolve", "--input=-"], JSON.stringify({ ...guarded, branchId: "left", conflictToken: "bad" })],
    [["resolve", "--input=-"], JSON.stringify({ ...guarded, content: "---\nid: forged\n---\ntext" })],
    [["resolve", "--input=-"], JSON.stringify({ ...guarded, content: "text", scope: "private" })],
    [["recall", "--limit", "2"], ""],
    [["search", "query", "--limit=21"], ""],
    [["read", "MEMORY.md", "--offset=-1"], ""],
    [["read", "MEMORY.md", "--offset=99999999999999999999"], ""],
    [["search", "unquoted", "query"], ""],
    [["recall", "--spcae=private"], ""],
    [["recall", "--root"], ""],
  ];
  for (const [args, input] of invalid) {
    const result = call(args, input);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("USAGE");
  }
  expect(await readdir(root)).toEqual([]);
});

test("dash-prefixed queries work after -- and traversal errors cannot read outside memory", async () => {
  const { root, call } = await fixture();
  expect(call(["search", "--", "--help"]).status).toBe(0);
  const result = call(["read", "../../outside.md"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error.message).toContain("without directories");
  expect(await readdir(root)).toEqual([]);
});
