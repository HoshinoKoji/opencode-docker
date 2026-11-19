import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

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

test("invalid flags and JSON are rejected before any writes", async () => {
  const { root, call } = await fixture();
  const invalid = [
    [["record"], ""],
    [["record", "--space=both", "--input=-"], JSON.stringify(record)],
    [["record", "--input=-"], "not-json"],
    [["record", "--input=-"], "[]"],
    [["record", "--input=-"], JSON.stringify({ ...record, scope: "private" })],
    [["record", "--input=-"], JSON.stringify({ ...record, nextSteps: 12 })],
    [["record", "--input=-"], JSON.stringify({ ...record, topic: "../escape" })],
    [["update", "--input=-"], '{"content":"Missing revision"}'],
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
