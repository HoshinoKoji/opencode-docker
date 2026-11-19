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
import { digest, encode } from "../config/chat/memory-plugin/format.js";
import { MemoryStore } from "../config/chat/memory-plugin/store.js";
import { upgradeSync, syncStatus } from "../config/chat/memory-plugin/upgrade.js";
import { SyncPrototype } from "../config/chat/memory-plugin/sync-prototype.js";
import { exportMarkdown, importMarkdown } from "../config/chat/memory-plugin/transfer.js";

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

for (const schema of [1, 2]) test(`SQLite v${schema}: session section and whole-body edits preserve metadata and history`, async () => {
  const root = await fixture(), store = createMemoryStore(root);
  if (schema === 2) {
    await store.init("shared");
    await upgradeSync({ root });
  }
  const saved = await store.record("build", { ...input, preferences: "recorded preference" }, "named-edit");
  const { name } = saved;
  const before = await read(store, { name });
  const section = await read(store, { name, section: "Details" });
  expect(section.revision).toBe(before.revision);
  for (const input of [
    { name: "../" + name, content: "invalid", expectedRevision: section.revision },
    { name: "INDEX.md", content: "invalid", expectedRevision: section.revision },
    { name: "2001-01-01-missing.md", content: "invalid", expectedRevision: digest("") },
    { name, section: "Details", content: "## Renamed\ninvalid", expectedRevision: section.revision },
    { name, content: encode(section.metadata, "invalid"), expectedRevision: section.revision },
  ]) await expect(store.update("build", input)).rejects.toThrow();
  const edited = await store.update("build", { name, section: "Details", content: "## Details\nupdated-marker", expectedRevision: section.revision });
  expect(edited.name).toBe(name);
  expect(edited.section).toBe("Details");
  expect((await read(store, { name })).text).toBe("# synthetic\n\n## Goal\nContract\n\n## Details\nupdated-marker\n\n");
  await expect(store.update("build", { name, content: "stale", expectedRevision: before.revision })).rejects.toThrow("Memory changed");
  await expect(store.record("build", { ...input, preferences: "recorded preference" }, "named-edit")).rejects.toThrow("different content");
  expect((await store.search("build", { query: "updated-marker" })).matches).toBe(1);
  const whole = await store.update("build", { name, content: "# Rewritten\nwhole-marker", expectedRevision: edited.revision });
  const current = await read(store, { name });
  expect(current.revision).toBe(whole.revision);
  expect(current.text).toBe("# Rewritten\nwhole-marker\n");
  expect(current.metadata).toEqual({ ...before.metadata, updated_at: current.metadata.updated_at });
  expect((await store.recall("build")).spaces[0].recent[0]).toContain("Saved | recorded preference");
  expect((await read(store, { name: "INDEX.md" })).text).toContain("Saved | recorded preference");
  await store.connection("shared", (db) => {
    const versions = db.query("SELECT * FROM versions WHERE document_id = ?").all(saved.id);
    expect(versions.map((row) => row.revision)).toEqual([saved.revision, edited.revision, whole.revision]);
    expect(versions.map((row) => row.parent)).toEqual([null, versions[0].operation_id, versions[1].operation_id]);
    expect(db.query("PRAGMA user_version").get().user_version).toBe(schema);
    const outbox = schema === 2 ? new SyncPrototype(db).pending() : db.query("SELECT * FROM outbox").all();
    expect(outbox).toHaveLength(3);
  });
  if (schema === 1) {
    await expect(store.delete("build", { name, expectedRevision: current.revision })).rejects.toThrow("requires SQLite schema v2");
    expect((await syncStatus({ root })).schema).toBe(1);
    expect(await read(store, { name })).toEqual(current);
  }
});

test("imported plain records keep legacy identity, summary and date; unknown names are never created", async () => {
  const root = await fixture(), store = createMemoryStore(root);
  const source = await fixture(), name = "2001-02-03-legacy-topic.md", empty = "2001-02-03-empty.md";
  const input = "# Original title\n- Conclusion / deliverables: Original summary\n## Details\nOld details\n";
  await mkdir(path.join(source, ".sessions"));
  await writeFile(path.join(source, ".sessions", name), input);
  await writeFile(path.join(source, ".sessions", empty), "");
  await expect(store.delete("build", { name, expectedRevision: digest(input) })).rejects.toThrow("requires SQLite schema v2");
  expect(await readdir(root)).toEqual([]);
  await importMarkdown({ root, source });
  const legacyId = await store.connection("shared", (db) => db.query("SELECT id FROM documents WHERE name = ?").get(name).id);
  expect((await read(store, { name })).metadata).toBeNull();
  await upgradeSync({ root });
  const changed = await store.update("build", { name, content: "# Revised title\nNew details", expectedRevision: digest(input) });
  expect((await read(store, { name })).metadata).toMatchObject({
    id: legacyId, type: "session", summary: "Original summary", title: "Original title",
    date: "2001-02-03", created_at: "2001-02-03T00:00:00.000Z",
  });
  expect((await store.delete("build", { name, expectedRevision: changed.revision })).id).toBe(legacyId);
  expect((await store.delete("build", { name: empty, expectedRevision: digest("") })).deleted).toBe(true);
  expect(await readFile(path.join(source, ".sessions", name), "utf8")).toBe(input);
  for (const dryRun of [true, false]) await expect(importMarkdown({ root, source, dryRun })).rejects.toThrow("deleted");
});

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
  const record = JSON.parse((await a.read.execute({ name: saved.name }, context)).content).results[0];
  const edited = JSON.parse((await b.update.execute({ name: saved.name, content: "edited plugin record", expectedRevision: record.revision }, context)).content);
  expect((await run(["search", "edited plugin", "--root", root], {})).result.results[0].name).toBe(saved.name);
  const deletion = { name: saved.name, expectedRevision: edited.revision };
  if (schema === 2) {
    expect(JSON.parse((await b.delete.execute(deletion, context)).content)).toEqual({
      scope: "shared", name: saved.name, logicalPath: saved.logicalPath, id: saved.id, deleted: true,
    });
    await expect(a.record.execute(input, context)).rejects.toThrow("deleted");
  } else {
    await expect(b.delete.execute(deletion, context)).rejects.toThrow("requires SQLite schema v2");
  }
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

test("public v2 tombstones retain history, roll back on failure, and propagate through a relay without resurrection", async () => {
  const root = await fixture(), store = createMemoryStore(root);
  const saved = await store.record("build", input, "relay-record");
  // Seed this operation under an older filename to exercise retry identity
  // lookup even when the retry generates a different UTC filename.
  const name = "2000-01-01-relay-record.md";
  await store.locked(() => {
    store.transaction.getStore().db.query("UPDATE documents SET name = ? WHERE id = ?").run(name, saved.id);
  }, "shared");
  await upgradeSync({ root });
  const seed = await store.connection("shared", (db) => db.serialize());
  async function replica() {
    const other = await fixture();
    await mkdir(path.join(other, ".memory-db"));
    await writeFile(path.join(other, ".memory-db/shared.sqlite"), seed);
    return createMemoryStore(other);
  }
  const remote = await replica(), relay = await replica();
  const before = await read(store, { name });
  const changed = await store.update("build", { name, content: "# Retained history\nchanged-marker", expectedRevision: before.revision });
  const deletion = { name, expectedRevision: changed.revision };
  for (const badName of ["MEMORY.md", "INDEX.md", `../${name}`, `${name}\n`]) {
    await expect(store.delete("build", { ...deletion, name: badName })).rejects.toThrow("session record filename");
  }
  await expect(store.delete("build", { name })).rejects.toThrow("expectedRevision");
  await expect(store.delete("build", { ...deletion, expectedRevision: before.revision })).rejects.toThrow("Memory changed");
  await expect(store.delete("build", { ...deletion, name: "2000-01-01-missing.md" })).rejects.toThrow("not found");
  const snapshot = () => store.connection("shared", (db) =>
    ["documents", "versions", "outbox", "sync_seed", "sync_operations", "sync_views", "sync_sections", "sync_outbox", "sync_versions", "sync_log"]
      .map((table) => db.query(`SELECT * FROM ${table}`).all()));
  const state = await snapshot();
  const db = await store.open("shared", true);
  try {
    db.exec(`CREATE TRIGGER fail_delete BEFORE INSERT ON sync_log
      BEGIN SELECT RAISE(ABORT, 'synthetic sync failure'); END;`);
    await expect(store.delete("build", deletion)).rejects.toThrow("synthetic sync failure");
    expect(await snapshot()).toEqual(state);
    db.exec("DROP TRIGGER fail_delete");
  } finally { db.close(); }
  expect((await store.delete("build", deletion)).deleted).toBe(true);
  expect((await snapshot()).slice(0, 4)).toEqual(state.slice(0, 4));
  const pending = await store.connection("shared", (db) => {
    const sync = new SyncPrototype(db);
    const ops = sync.pending();
    const edit = ops.find((op) => op.kind === "full"), deleted = ops.find((op) => op.kind === "delete");
    expect(deleted).toMatchObject({ document: saved.id, base: [edit.id], content: null });
    const tombstone = db.query("SELECT raw, deleted FROM sync_versions WHERE id = ?").get(deleted.id);
    expect(tombstone.deleted).toBe(1);
    expect(tombstone.raw).toContain("changed-marker");
    return ops;
  });
  const relayDb = await relay.open("shared", true), remoteDb = await remote.open("shared", true);
  try {
    const bridge = new SyncPrototype(relayDb), receiver = new SyncPrototype(remoteDb);
    const first = bridge.push(pending);
    expect(bridge.push(pending)).toEqual(first);
    const firstPage = bridge.pull("relay", 0, 1);
    receiver.receive(firstPage);
    expect((await read(remote, { name })).text).toContain("changed-marker");
    const lastPage = bridge.pull("relay", 1);
    receiver.receive(lastPage);
    receiver.receive(firstPage);
    receiver.receive(lastPage);
    expect(receiver.view(saved.id).deleted).toBe(1);
  } finally { relayDb.close(); remoteDb.close(); }
  for (const replica of [store, remote]) {
    expect((await read(replica, { name })).text).toBe("");
    expect((await read(replica, { name: "INDEX.md" })).text).not.toContain("relay-record");
    expect((await replica.recall("build")).spaces[0].recent).toEqual([]);
    expect((await replica.search("build", { query: "changed-marker" })).matches).toBe(0);
    await expect(replica.record("build", input, "relay-record")).rejects.toThrow("deleted");
    await expect(replica.update("build", { name, content: "resurrect", expectedRevision: digest("") })).rejects.toThrow("deleted");
    await expect(replica.delete("build", deletion)).rejects.toThrow("deleted");
    const destination = path.join(await fixture(), "export");
    expect((await exportMarkdown({ root: replica.root, destination })).documents).toBe(0);
    expect(await readdir(destination)).toEqual([]);
  }
  const source = await fixture();
  await mkdir(path.join(source, ".sessions"));
  const sourceName = path.join(source, ".sessions", name);
  const renamed = path.join(source, ".sessions", "2000-01-01-other.md");
  const original = encode(before.metadata, before.text);
  await writeFile(sourceName, "# Different ID, tombstoned name");
  await expect(importMarkdown({ root, source, dryRun: true })).rejects.toThrow("deleted");
  await rm(sourceName);
  await writeFile(renamed, original);
  await expect(importMarkdown({ root, source })).rejects.toThrow("deleted");
  expect(await readFile(renamed, "utf8")).toBe(original);
});

test("public session deletion and edits freeze conflicted v2 documents", async () => {
  const root = await fixture(), store = createMemoryStore(root);
  const { name, id } = await store.record("build", input, "conflicted-session");
  await upgradeSync({ root });
  const db = await store.open("shared", true), sync = new SyncPrototype(db);
  try {
    const raw = sync.view(id).raw;
    const left = sync.prepare({ id: "left", document: id, kind: "full", content: raw + "left\n" });
    const right = sync.prepare({ id: "right", document: id, kind: "full", content: raw + "right\n" });
    sync.push([left, right]);
    const { revision } = await read(store, { name });
    await expect(store.delete("build", { name, expectedRevision: revision })).rejects.toThrow("conflict resolution");
    await expect(store.update("build", { name, content: "edit", expectedRevision: revision })).rejects.toThrow("conflict resolution");
    await expect(store.record("build", input, "conflicted-session")).rejects.toThrow("conflict resolution");
    expect(sync.view(id)).toMatchObject({ raw, deleted: 0, conflicts: [{ document: id, left_id: "left", right_id: "right" }] });
    expect(sync.pending()).toEqual([]);
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
