import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createMemoryStore } from "../config/chat/memory-plugin/backend.js";
import { ExternalMemoryStore } from "../config/chat/memory-mcp/policy.js";
import { run } from "../config/chat/memory-plugin/cli.js";
import plugin from "../config/chat/memory-plugin/index.js";
import { encode } from "../config/chat/memory-plugin/format.js";
import { MemoryStore } from "../config/chat/memory-plugin/store.js";
import { upgradeSync, syncStatus } from "../config/chat/memory-plugin/upgrade.js";
import { SyncPrototype } from "../config/chat/memory-plugin/sync-prototype.js";
import { exportMarkdown } from "../config/chat/memory-plugin/transfer.js";

const directories = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-sqlite-test-"));
  directories.push(root);
  return root;
}
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});
const input = { topic: "synthetic", goal: "Contract", conclusion: "Saved", details: "中文 Mixed CASE\n### Nested\nchild" };
test("backends return byte-identical contracts for identical synthetic snapshots", async () => {
  const stores = [new MemoryStore(await fixture()), createMemoryStore(await fixture())];
  const metadata = { schema_version: 1, id: "synthetic-memory", type: "long_term", date: "2026-01-01", topic: "memory", summary: "fixture", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", custom: "preserved" };
  for (const store of stores) {
    await store.locked(async () => {
      await store.atomic(store.relative("shared", "MEMORY.md"), encode(metadata, "# Memory\n## Summary\nbrief\n## Detail\n中文 Case\n### Child\nnested\n"));
      await store.atomic(store.relative("shared", "2026-01-01-synthetic.md"), encode({ ...metadata, id: "synthetic-record", type: "session" }, "# Synthetic\n中文 Case\n"));
    }, "shared");
  }
  for (const [method, input] of [["recall", {}], ["search", { query: "中文 CASE" }], ["read", { name: "MEMORY.md" }], ["read", { name: "MEMORY.md", section: "Detail", offset: 4, limit: 9 }], ["read", { name: "INDEX.md" }]]) {
    expect(await stores[0][method]("build", input)).toEqual(await stores[1][method]("build", input));
  }
});

test("SQLite: waits for a busy writer, then persists exactly one retry version", async () => {
  const root = await fixture();
  const store = createMemoryStore(root, { backend: "sqlite" });
  await store.record("build", input, "first");
  const db = new Database(path.join(root, ".memory-db/shared.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  const release = setTimeout(() => db.exec("ROLLBACK"), 200);
  try {
    const saved = await store.record("build", input, "second");
    expect(await store.record("build", input, "second")).toEqual(saved);
    expect(db.query("SELECT count(*) AS n FROM versions").get().n).toBe(2);
    expect(db.query("SELECT count(*) AS n FROM outbox").get().n).toBe(2);
  } finally {
    clearTimeout(release);
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
  }
});

test("SQLite: independent CLI processes race initialization and reuse one root", async () => {
  const root = await fixture();
  const cwd = await fixture();
  const source = path.join(cwd, "synthetic-input.json");
  await writeFile(source, JSON.stringify(input));
  const cli = path.resolve(import.meta.dir, "../config/chat/memory-plugin/cli.js");
  const invoke = async (id) => JSON.parse((await promisify(execFile)(process.execPath,
    [cli, "record", "--backend", "sqlite", "--root", root, "--input", source, "--request-id", id],
    { cwd })).stdout);
  const saved = await Promise.all(["one", "two", "three", "four"].map(invoke));
  expect(new Set(saved.map((row) => row.id)).size).toBe(4);
  expect(await invoke("one")).toEqual(saved[0]);
  expect((await createMemoryStore(root, { backend: "sqlite" }).recall("build")).spaces[0].recent).toHaveLength(4);
  expect(await readdir(cwd)).toEqual(["synthetic-input.json"]);
});
const read = async (store, options = {}) => (await store.read("build", { name: "MEMORY.md", ...options })).results[0];

for (const schema of [1, 2]) {
  const backend = "sqlite";
  test(`${backend} v${schema}: public contract, progressive reads, retries, metadata, revisions and policy`, async () => {
    const root = await fixture();
    const store = createMemoryStore(root, { backend });
    if (schema === 2) for (const scope of ["shared", "private"]) {
      await store.init(scope);
      await upgradeSync({ root, scope });
    }
    const empty = await read(store);
    expect(empty.text).toBe("");
    expect((await store.recall("build")).spaces[0].memory.mode).toBe("full");
    const saved = await store.record("build", input, "stable-call");
    expect(saved.logicalPath).toBe(`.sessions/${saved.name}`);
    expect(saved).not.toHaveProperty("path");
    expect(await store.record("build", input, "stable-call")).toEqual(saved);
    await expect(store.record("build", { ...input, details: "changed" }, "stable-call")).rejects.toThrow("different content");
    expect((await store.search("build", { query: "中文 CASE" })).results[0].name).toBe(saved.name);
    expect((await store.search("build", { query: "not-present" })).matches).toBe(0);
    expect((await store.recall("build")).spaces[0].recent).toHaveLength(1);
    expect((await store.read("build", { name: "INDEX.md" })).results[0].text).toContain("Saved");
    await store.update("build", { content: "# Memory\n## Summary\nbrief\n## Detail\n中文\n### Child\nold\n## Last\nkeep", expectedRevision: empty.revision });
    const whole = await read(store);
    const section = await read(store, { section: "Detail" });
    expect(section.revision).toBe(whole.revision);
    expect(section.metadata).toEqual(whole.metadata);
    const page = await read(store, { section: "Detail", offset: 3, limit: 8 });
    expect(page.text).toBe(section.text.slice(3, 11));
    expect(page.total).toBe(section.total);
    expect(page.truncated).toBe(true);
    expect((await store.recall("build")).spaces[0].memory.text).not.toContain("old");
    await expect(read(store, { section: "missing" })).rejects.toThrow("Section not found");
    await expect(store.update("build", { section: "Detail", content: "## Renamed\nx", expectedRevision: whole.revision })).rejects.toThrow();
    await store.update("build", { section: "Detail", content: "## Detail\nnew\n### Child\nchanged", expectedRevision: whole.revision });
    const updated = await read(store);
    expect(updated.text).toContain("## Last\nkeep");
    expect(updated.metadata.id).toBe(whole.metadata.id);
    expect(updated.metadata.created_at).toBe(whole.metadata.created_at);
    await expect(store.update("build", { content: "stale", expectedRevision: whole.revision })).rejects.toThrow("Memory changed");
    for (const agent of ["temp", "general", "explore"]) await expect(store.recall(agent)).rejects.toThrow("available only");
    await expect(store.recall("build", { scope: "private" })).rejects.toThrow("shared memory only");
    await expect(store.record("plan", input, "denied")).rejects.toThrow("read-only");
    await expect(store.record("casual", { ...input, scope: "shared" }, "denied")).rejects.toThrow("share=true");
    await store.record("casual", { ...input, details: "private-only" }, "private-call");
    expect((await store.search("build", { query: "private-only" })).matches).toBe(0);
    expect((await store.search("casual", { query: "private-only" })).results[0].scope).toBe("private");
    expect(await read(createMemoryStore(root, { backend }))).toEqual(updated);
    const readonly = new ExternalMemoryStore(root, { backend, readOnly: true });
    await expect(readonly.record(null, input, "denied")).rejects.toThrow("read-only");
    await expect(readonly.recall(null, { scope: "private" })).rejects.toThrow("shared scope only");
    expect((await readonly.read(null, { name: "MEMORY.md" })).results[0]).toEqual(updated);
  });
}

test("SQLite: atomic history/outbox rollback and concurrent revision checks", async () => {
  const root = await fixture();
  const store = createMemoryStore(root, { backend: "sqlite" });
  const initial = await read(store);
  const results = await Promise.allSettled([
    store.update("build", { content: "first", expectedRevision: initial.revision }),
    createMemoryStore(root, { backend: "sqlite" }).update("build", { content: "second", expectedRevision: initial.revision }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected").reason.message).toContain("Memory changed");
  const before = await read(store);
  // Inject a failure after the SQL writes, proving all three tables roll back.
  const atomic = store.atomic.bind(store);
  store.atomic = async (...args) => { await atomic(...args); throw new Error("synthetic crash"); };
  await expect(store.update("build", { content: "lost", expectedRevision: before.revision })).rejects.toThrow("synthetic crash");
  expect(await read(store)).toEqual(before);
  const db = new Database(path.join(root, ".memory-db/shared.sqlite"));
  try {
    expect(db.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    expect(db.query("PRAGMA user_version").get().user_version).toBe(1);
    for (const table of ["documents", "versions", "outbox"]) expect(db.query(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(1);
  } finally { db.close(); }
  expect(await readdir(root)).toEqual([".memory-db"]);
  expect(await readdir(path.join(root, ".memory-db"))).toEqual(["shared.sqlite"]);
});

test("SQLite: read-only empty store, explicit root, no Markdown discovery, schema and symlink refusal", async () => {
  const root = await fixture();
  const store = createMemoryStore(root, { backend: "sqlite" });
  await store.recall("build");
  expect(await readdir(root)).toEqual([]);
  await mkdir(path.join(root, ".sessions"));
  await writeFile(path.join(root, ".sessions/MEMORY.md"), "synthetic Markdown ignored");
  expect((await read(store)).text).toBe("");
  expect(() => createMemoryStore("relative", { backend: "sqlite" })).toThrow("absolute");
  await expect(run(["recall", "--backend", "sqlite"], {})).rejects.toThrow("explicit absolute");
  await mkdir(path.join(root, ".memory-db"));
  const file = path.join(root, ".memory-db/shared.sqlite");
  const db = new Database(file);
  db.exec("PRAGMA user_version = 99");
  db.close();
  await expect(read(store)).rejects.toThrow("Unsupported");
  await rm(file);
  await symlink(path.join(root, ".sessions/MEMORY.md"), file);
  await expect(read(store)).rejects.toThrow("symlinks");
});

for (const schema of [1, 2]) test(`SQLite v${schema}: plugin and CLI use one explicit root across unrelated worktrees`, async () => {
  const root = await fixture();
  if (schema === 2) {
    await createMemoryStore(root).init("shared");
    await run(["upgrade-sync", "--root", root]);
  }
  async function tools(project) {
    const result = {};
    await plugin.setup({ options: { backend: "sqlite", root }, location: { project: { directory: project } },
      tool: { transform: async (fn) => fn({ namespace() {}, add: (tool) => { result[tool.name] = tool; } }) },
      permission: { assert: async () => {} } });
    return result;
  }
  const a = await tools(await fixture());
  const b = await tools(await fixture());
  const context = { agent: "build", sessionID: "synthetic", messageID: "m", id: "call" };
  const saved = JSON.parse((await a.record.execute(input, context)).content);
  expect(saved.logicalPath).toBe(`.sessions/${saved.name}`);
  expect(saved).not.toHaveProperty("path");
  expect(JSON.parse((await b.record.execute(input, context)).content)).toEqual(saved);
  const cli = await run(["search", "中文", "--backend", "sqlite", "--root", root], {});
  expect(cli.result.results[0].name).toBe(saved.name);
  const initial = JSON.parse((await a.read.execute({ name: "MEMORY.md" }, context)).content).results[0];
  await b.update.execute({ content: "# Memory\n## Detail\nold\n## Last\nkeep", expectedRevision: initial.revision }, context);
  const selected = JSON.parse((await a.read.execute({ name: "MEMORY.md", section: "Detail" }, context)).content).results[0];
  await b.update.execute({ section: "Detail", content: "## Detail\nnew", expectedRevision: selected.revision }, context);
  const changed = JSON.parse((await a.read.execute({ name: "MEMORY.md" }, context)).content).results[0];
  expect(changed.text).toContain("## Detail\nnew");
  expect(changed.text).toContain("## Last\nkeep");
  expect(changed.metadata.id).toBe(selected.metadata.id);
  await expect(b.update.execute({ content: "stale", expectedRevision: initial.revision }, context)).rejects.toThrow("Memory changed");
  await expect(b.record.execute(input, { ...context, agent: "plan" })).rejects.toThrow("read-only");
  await expect(b.read.execute({ name: "MEMORY.md", scope: "private" }, context)).rejects.toThrow("shared memory only");
  await expect(plugin.setup({ options: { backend: "sqlite" }, location: { project: { directory: root } } })).rejects.toThrow("absolute");
});

test("explicit upgrade previews without writes, preserves v1 backup/history/outbox and is repeatable", async () => {
  const root = await fixture(), store = createMemoryStore(root);
  await store.record("build", input, "before-upgrade");
  await store.update("build", { content: "# Memory\n## Detail\nold\n", expectedRevision: (await read(store)).revision });
  const before = await read(store);
  const snapshot = (db) => ["documents", "versions", "outbox", "store_info"].map((table) => db.query(`SELECT * FROM ${table}`).all());
  const original = await store.connection("shared", snapshot);
  const files = await readdir(path.join(root, ".memory-db"));
  expect((await run(["upgrade-sync", "--root", root, "--dry-run"])).result.targetSchema).toBe(2);
  expect(await readdir(path.join(root, ".memory-db"))).toEqual(files);
  expect((await syncStatus({ root })).schema).toBe(1);
  const report = (await run(["upgrade-sync", "--root", root])).result;
  expect(report.upgraded).toBe(true);
  const backup = new Database(report.backupPath, { readonly: true });
  try {
    expect(backup.query("PRAGMA user_version").get().user_version).toBe(1);
    expect(snapshot(backup)).toEqual(original);
  } finally { backup.close(); }
  expect(await store.connection("shared", snapshot)).toEqual(original);
  expect(await read(store)).toEqual(before);
  expect((await upgradeSync({ root })).upgraded).toBe(false);
  const sections = () => store.connection("shared", (db) => db.query("SELECT id FROM sync_sections WHERE document = ? ORDER BY position").all(before.metadata.id));
  const ids = await sections();
  await store.update("build", { section: "Detail", content: "## Detail\nnew", expectedRevision: before.revision });
  expect(await sections()).toEqual(ids);
  expect((await read(store)).metadata.id).toBe(before.metadata.id);
  expect((await syncStatus({ root })).pending).toBe(1);
  await store.connection("shared", (db) => {
    expect(db.query("SELECT * FROM outbox").all()).toEqual(original[2]);
    const op = db.query("SELECT id FROM sync_operations").get();
    expect(db.query("SELECT operation_id FROM versions WHERE operation_id = ?").get(op.id)).not.toBeNull();
  });
  await expect(run(["upgrade-sync", "--root", root, "--space", "both"])).rejects.toThrow("one explicit space");
});

test("v2 runtime rollback includes operation, stable IDs, legacy history and pending queue", async () => {
  const root = await fixture(), store = createMemoryStore(root);
  await store.init("shared"); await upgradeSync({ root });
  const atomic = store.atomic.bind(store);
  store.atomic = async (...args) => { await atomic(...args); throw new Error("synthetic crash"); };
  await expect(store.record("build", input, "fail")).rejects.toThrow("synthetic crash");
  await store.connection("shared", (db) => {
    for (const table of ["documents", "versions", "outbox", "sync_seed", "sync_operations", "sync_views", "sync_sections", "sync_outbox", "sync_versions", "sync_log"]) {
      expect(db.query(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(0);
    }
  });
  store.atomic = atomic;
  const saved = await store.record("build", input, "fail");
  expect(await store.record("build", input, "fail")).toEqual(saved);
  expect((await syncStatus({ root })).pending).toBe(1);
});

test("v2 runtime sees received records/edits, exports projections, and blocks conflicted/deleted writes", async () => {
  const root = await fixture(), store = createMemoryStore(root);
  await store.update("build", { content: "# Memory\n## Detail\nold", expectedRevision: (await read(store)).revision });
  await upgradeSync({ root });
  const before = await read(store);
  const db = await store.open("shared", true), sync = new SyncPrototype(db);
  try {
    const other = await fixture();
    await mkdir(path.join(other, ".memory-db"));
    await writeFile(path.join(other, ".memory-db/shared.sqlite"), db.serialize());
    const remote = createMemoryStore(other);
    const saved = await remote.record("build", input, "remote-create");
    const operations = await remote.connection("shared", (replica) => new SyncPrototype(replica).pending());
    sync.push(operations);
    expect((await store.read("build", { name: saved.name })).results[0].text).toContain("中文");
    const destination = path.join(await fixture(), "export");
    await exportMarkdown({ root, destination });
    expect(await readFile(path.join(destination, saved.logicalPath), "utf8")).toContain("中文");
    const raw = sync.view(before.metadata.id).raw;
    const left = sync.prepare({ id: "left", document: before.metadata.id, kind: "full", content: raw.replace("old", "left") });
    const right = sync.prepare({ id: "right", document: before.metadata.id, kind: "full", content: raw.replace("old", "right") });
    sync.push([left]);
    expect((await read(store)).text).toContain("left");
    sync.push([right]);
    expect((await syncStatus({ root })).conflicts).toHaveLength(1);
    await expect(store.update("build", { content: "resolve", expectedRevision: (await read(store)).revision })).rejects.toThrow("conflict resolution");
    sync.push([{ ...sync.prepare({ id: "delete", document: before.metadata.id, kind: "delete" }), base: [] }]);
    expect((await read(store)).text).toBe("");
    await expect(store.update("build", { content: "restore", expectedRevision: (await read(store)).revision })).rejects.toThrow();
  } finally { db.close(); }
});

test("upgrade rejects malformed history and read-only engine mutations; absent databases stay absent", async () => {
  const root = await fixture(), store = createMemoryStore(root);
  await expect(upgradeSync({ root, dryRun: true })).rejects.toThrow("Initialize");
  expect(await readdir(root)).toEqual([]);
  await store.record("build", input, "seed");
  let db = await store.open("shared", true);
  db.exec("UPDATE versions SET revision = 'broken'"); db.close();
  await expect(upgradeSync({ root, dryRun: true })).rejects.toThrow("history");
  expect((await syncStatus({ root })).schema).toBe(1);
  const other = await fixture(), otherStore = createMemoryStore(other);
  await otherStore.init("shared"); await upgradeSync({ root: other });
  db = await otherStore.open("shared");
  try {
    const sync = new SyncPrototype(db);
    expect(() => sync.commit(sync.prepare({ id: "creation", document: "doc", name: "MEMORY.md", kind: "create", content: "# Synthetic\n" }))).toThrow();
    expect(sync.pending()).toEqual([]);
  } finally { db.close(); }
});
