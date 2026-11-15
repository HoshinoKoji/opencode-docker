import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const wrapper = path.resolve(import.meta.dir, "../memory.sh");
const directories = [];
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

test("CLI help is side-effect free even with a nonexistent root", async () => {
  const { root, call } = await fixture();
  const result = call(["--root", "/does-not-exist", "record", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("expectedRevision");
  expect(result.stderr).toBe("");
  expect(await readdir(root)).toEqual([]);
});

test("external cwd, root override, stdin and file writes, and explicit spaces", async () => {
  const { root, directory, call } = await fixture();
  const first = call(["record", "--input=-", "--request-id=stable-key"], JSON.stringify(record));
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  const saved = JSON.parse(first.stdout);
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
  expect(await readdir(root)).toContain(".sessions");
});

test("stable request IDs retry records after a filename/date change without duplicates", async () => {
  const { root, call } = await fixture();
  const args = ["record", "--input", "-", "--request-id", "retry-key"];
  const first = JSON.parse(call(args, JSON.stringify(record)).stdout);
  const renamed = ".sessions/2000-01-01-renamed.md";
  await rename(path.join(root, first.path), path.join(root, renamed));
  const second = call(args, JSON.stringify(record));
  expect(second.status).toBe(0);
  expect(JSON.parse(second.stdout).path).toBe(renamed);
  expect(JSON.parse(second.stdout).id).toBe(first.id);
  expect((await readdir(path.join(root, ".sessions"))).filter((f) => f !== "INDEX.md")).toEqual(["2000-01-01-renamed.md"]);
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
  const raw = await readFile(path.join(root, ".sessions/MEMORY.md"), "utf8");
  expect(raw).toStartWith("---\n");
  const stale = call(["update", "--input=-"], input);
  expect(stale.status).toBe(1);
  expect(stale.stdout).toBe("");
  expect(JSON.parse(stale.stderr).error.message).toContain("Memory changed");
  expect(await readFile(path.join(root, ".sessions/MEMORY.md"), "utf8")).toBe(raw);
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
