import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { decode, digest, encode } from "../config/chat/memory-plugin/format.js";
import { migratePrototypeV2, SyncPrototype } from "../config/chat/memory-plugin/sync-prototype.js";
import { SQLiteMemoryStore } from "../config/chat/memory-plugin/sqlite.js";

const roots = [], connections = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const metadata = { schema_version: 1, id: "doc", type: "long_term", date: "2026-01-01", topic: "synthetic",
  summary: "fixture", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", custom: "keep" };
const body = "# Memory\nintro\n## Alpha\nold A\n### Child\nold child\n## Beta\nold B\n";
const raw = encode(metadata, body);
function v1() {
  const root = mkdtempSync(path.join(os.tmpdir(), "memory-sync-")); roots.push(root);
  const filename = path.join(root, "synthetic.sqlite");
  const db = new Database(filename, { strict: true }); connections.push(db);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
    CREATE TABLE store_info (scope TEXT NOT NULL);
    INSERT INTO store_info VALUES ('shared');
    CREATE TABLE documents (name TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, raw TEXT NOT NULL, revision TEXT NOT NULL, head TEXT NOT NULL);
    CREATE TABLE versions (operation_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, parent TEXT, revision TEXT NOT NULL, raw TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE outbox (operation_id TEXT PRIMARY KEY REFERENCES versions(operation_id));
    PRAGMA user_version = 1;`);
  db.query("INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)").run("old", "doc", null, digest("older"), "older", "2026-01-01T00:00:00.000Z");
  db.query("INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)").run("seed", "doc", "old", digest(raw), raw, "2026-01-01T00:00:00.000Z");
  db.query("INSERT INTO outbox VALUES (?)").run("seed");
  db.query("INSERT INTO documents VALUES (?, ?, ?, ?, ?)").run("MEMORY.md", "doc", raw, digest(raw), "seed");
  return { db, filename, root };
}
function device() {
  const fixture = v1();
  migratePrototypeV2(fixture.db, { spaceId: "synthetic-space", synthetic: true });
  return Object.assign(new SyncPrototype(fixture.db), fixture);
}
function edit(d, id, title, content) {
  return d.prepare({ id, document: "doc", target: d.view("doc").sections.find((node) => node.title === title).id, content });
}
const alpha = (text) => `## Alpha\n${text}\n### Child\nold child\n`;
const beta = (text) => `## Beta\n${text}\n`;
function roundtrip(a, b, relay) {
  a.acknowledge(relay.push(a.pending())); b.acknowledge(relay.push(b.pending()));
  const page = relay.pull("relay"); a.receive(page); b.receive(page);
  expect(a.view("doc")).toEqual(b.view("doc"));
}

test("explicit additive v2 migration preserves all v1 rows, metadata, history, outbox and revisions", () => {
  const { db } = v1();
  const tables = ["documents", "versions", "outbox", "store_info"];
  const snapshot = () => tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  expect(() => migratePrototypeV2(db, { spaceId: "synthetic-space" })).toThrow("synthetic");
  migratePrototypeV2(db, { spaceId: "synthetic-space", synthetic: true });
  migratePrototypeV2(db, { spaceId: "synthetic-space", synthetic: true });
  expect(snapshot()).toEqual(before);
  const d = new SyncPrototype(db), view = d.view("doc");
  expect(view.raw).toBe(raw); expect(view.revision).toBe(digest(raw));
  expect(view.sections.map((node) => node.title)).toEqual(["Memory", "Alpha", "Child", "Beta"]);
  expect(view.sections[2].parent).toBe(view.sections[1].id);
  expect(view.sections[1].direct).toBe("## Alpha\nold A\n");
  expect(d.pending()).toEqual([]);
  expect(() => migratePrototypeV2(db, { spaceId: "other", synthetic: true })).toThrow("Space mismatch");
});

test("migration failure rolls back DDL and version; unknown versions rejected", () => {
  const { db } = v1();
  db.exec("CREATE TABLE sync_views (unexpected TEXT)");
  expect(() => migratePrototypeV2(db, { spaceId: "s", synthetic: true })).toThrow();
  expect(db.query("PRAGMA user_version").get().user_version).toBe(1);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'sync_info'").get()).toBeNull();
  db.exec("DROP TABLE sync_views; UPDATE documents SET revision = 'broken'");
  expect(() => migratePrototypeV2(db, { spaceId: "s", synthetic: true })).toThrow("Invalid v1");
  db.exec("PRAGMA user_version = 99");
  expect(() => migratePrototypeV2(db, { spaceId: "s", synthetic: true })).toThrow("schema 99");
});

test("runtime reads explicitly upgraded v2 projections", async () => {
  const d = device();
  // Override path resolution only in this fixture; never open workspace data.
  const store = new SQLiteMemoryStore(d.root);
  store.checked = async (relative) => relative.endsWith("shared.sqlite") ? d.filename : path.join(d.root, relative);
  expect((await store.read("build", { name: "MEMORY.md" })).results[0].text).toBe(body);
});

test("create operations replicate with stable sections and reject malformed names/identity collisions atomically", () => {
  const a = device(), b = device();
  const creation = a.prepare({ id: "new-record", document: "new-doc", kind: "create", name: "2026-01-01-new.md", content: "# New\n## Detail\ntext\n" });
  a.commit(creation);
  b.push(a.pending());
  expect(b.view("new-doc")).toEqual(a.view("new-doc"));
  b.push(a.pending());
  expect(b.operations()).toHaveLength(1);
  expect(() => b.push([{ ...creation, id: "bad-name", document: "other", name: "../escape.md" }])).toThrow("Malformed");
  expect(() => b.push([{ ...creation, id: "collision", document: "other" }])).toThrow("collision");
  expect(() => b.push([{ ...creation, id: "bad-body", document: "other", name: "2026-01-01-other.md", content: encode(metadata, body) }])).toThrow("identity changed");
  expect(b.operations()).toHaveLength(1);
  expect(b.db.query("SELECT id FROM sync_seed WHERE id = 'other'").get()).toBeNull();
});

test("independent offline section edits merge and stable identities survive restart", () => {
  const a = device(), b = device(), relay = device();
  const ids = a.view("doc").sections.map((node) => node.id);
  a.commit(edit(a, "a", "Alpha", alpha("A changed")));
  b.commit(edit(b, "b", "Beta", beta("B changed")));
  roundtrip(a, b, relay);
  expect(a.view("doc").raw).toContain("A changed"); expect(a.view("doc").raw).toContain("B changed");
  expect(a.view("doc").conflicts).toEqual([]);
  const reopened = new Database(a.filename); connections.push(reopened);
  expect(new SyncPrototype(reopened).view("doc").sections.map((node) => node.id)).toEqual(ids);
  expect(a.db.query("SELECT raw FROM documents").get().raw).toBe(raw);
  expect(a.view("doc").raw.split("# Memory")[0]).toBe(raw.split("# Memory")[0]);
});

for (const mode of ["same", "parent-child", "full", "structure"]) {
  test(`${mode} concurrent edits retain both branches and converge in either delivery order`, () => {
    const a = device(), b = device(), relay = device(), reverse = device();
    const left = a.commit(edit(a, "a", "Alpha", alpha("left")));
    const right = mode === "same" ? edit(b, "b", "Alpha", alpha("right"))
      : mode === "parent-child" ? edit(b, "b", "Child", "### Child\nright\n")
      : b.prepare({ id: "b", document: "doc", kind: "full", content: encode(metadata, mode === "structure" ? body.replace("## Beta", "## Renamed") : body.replace("intro", "right")) });
    b.commit(right);
    reverse.push([right]); reverse.push([left]);
    roundtrip(a, b, relay);
    expect(a.view("doc").conflicts).toHaveLength(1);
    expect(reverse.view("doc")).toEqual(a.view("doc"));
    expect(a.view("doc").raw).toBe(raw);
    expect(a.db.query("SELECT count(*) AS n FROM sync_versions").get().n).toBe(2);
    expect(() => a.commit(edit(a, "unresolved", "Beta", beta("new")))).toThrow("resolution");
  });
}

test("sequential edits and structural full rewrites persist new identities without guessing", () => {
  const a = device(), relay = device(), b = device();
  const ids = a.view("doc").sections.map((node) => node.id);
  const first = a.commit(edit(a, "z-first", "Beta", beta("first")));
  const second = a.commit(edit(a, "a-second", "Beta", beta("second")));
  relay.push([second, first]); // deliberately reverse dependencies
  b.receive(relay.pull("relay", 0, 1)); b.receive(relay.pull("relay", 1, 1));
  expect(b.view("doc")).toEqual(a.view("doc"));
  const replacement = a.prepare({ id: "full", document: "doc", kind: "full", content: encode(metadata, body.replace("## Beta", "## Renamed")) });
  a.commit(replacement);
  expect(a.view("doc").sections.map((node) => node.id).some((id) => ids.includes(id))).toBe(false);
  expect(a.db.query("SELECT count(*) AS n FROM sync_versions").get().n).toBe(3);
});

test("structural section changes, fence swallowing and metadata identity changes fail atomically", () => {
  const a = device();
  for (const content of ["## Renamed\nx\n", "## Alpha\nx\n", "## Alpha\n```\n### Child\nx\n", `stray text\n${alpha("changed")}`]) {
    expect(() => a.commit(edit(a, "bad", "Alpha", content))).toThrow("Structural");
  }
  expect(() => a.commit(edit(a, "bad", "Beta", "## Beta\n```\nunclosed\n"))).toThrow("closed");
  expect(() => a.commit(a.prepare({ id: "bad", document: "doc", kind: "full", content: encode({ ...metadata, id: "other" }, body) }))).toThrow("identity");
  expect(a.operations()).toEqual([]); expect(a.pending()).toEqual([]); expect(a.view("doc").raw).toBe(raw);
});

test("duplicate/lost push and pull responses preserve operation identity and one history row", () => {
  const a = device(), relay = device();
  const op = a.commit(edit(a, "a", "Beta", beta("changed")));
  const lost = relay.push(a.pending());
  expect(relay.push(a.pending())).toEqual(lost);
  a.commit(op); expect(a.pending()).toHaveLength(1);
  const page = relay.pull("relay"); a.receive(page); a.receive(page);
  a.acknowledge(lost); a.acknowledge(lost);
  expect(a.pending()).toEqual([]);
  expect(a.db.query("SELECT count(*) AS n FROM sync_versions").get().n).toBe(1);
  expect(a.db.query("SELECT position FROM sync_cursor").get().position).toBe(1);
  expect(relay.pull("relay").entries).toHaveLength(1);
  expect(() => relay.push([{ ...op, content: beta("different") }])).toThrow("different content");
  expect(() => a.commit({ ...op, content: beta("different") })).toThrow("different content");
  expect(() => a.receive({ ...page, entries: [{ sequence: 1, operation: { ...op, content: beta("different") } }] })).toThrow("different content");
});

test("deletion tombstones survive old device edits and retries without resurrection", () => {
  const a = device(), b = device(), relay = device();
  a.commit(a.prepare({ id: "delete", document: "doc", kind: "delete" }));
  const stale = b.commit(edit(b, "stale", "Beta", beta("offline")));
  roundtrip(a, b, relay);
  expect(a.view("doc").deleted).toBe(1); expect(a.view("doc").conflicts).toHaveLength(1);
  relay.push([stale]); expect(relay.view("doc").deleted).toBe(1);
  expect(a.db.query("SELECT raw FROM sync_versions WHERE id = 'stale'").get().raw).toContain("offline");
  const clean = device(); clean.commit(clean.prepare({ id: "delete", document: "doc", kind: "delete" }));
  expect(() => clean.commit(clean.prepare({ id: "revive", document: "doc", kind: "full", content: raw }))).toThrow("restoration");
});

test("late overlap blocks causal descendants while retaining their complete branch snapshots", () => {
  const a = device(), b = device();
  const first = a.commit(edit(a, "a", "Alpha", alpha("branch A")));
  const descendant = a.commit(edit(a, "descendant", "Beta", beta("descendant")));
  const overlap = b.commit(edit(b, "b", "Child", "### Child\nbranch B\n"));
  a.push([overlap]); b.push([descendant, first]);
  expect(a.view("doc")).toEqual(b.view("doc")); expect(a.view("doc").raw).toBe(raw);
  expect(a.db.query("SELECT raw FROM sync_versions WHERE id = 'descendant'").get().raw).toContain("descendant");
});

function resolve(d, id, choice, inspection = d.inspect("doc")) {
  return d.resolve({ id, document: "doc", expectedRevision: inspection.revision, conflictToken: inspection.conflictToken, ...choice });
}

for (const title of ["Alpha", "Child"]) {
  test(`resolution selects the ${title} branch without overwriting a safe sibling; replay permits sequential edits`, () => {
    const a = device(), b = device(), relay = device();
    const left = edit(a, "left", "Alpha", alpha("left"));
    const right = title === "Alpha" ? edit(a, "right", title, alpha("right"))
      : edit(a, "right", title, "### Child\nright\n");
    const safe = edit(a, "safe", "Beta", beta("safe edit"));
    a.push([left, right, safe]);
    const inspect = a.inspect("doc");
    expect(inspect.conflicts).toEqual([["left", "right"]]);
    expect(inspect.branches.map(({ operationId }) => operationId)).toEqual(["left", "right"]);
    expect(inspect.branches[1].raw).not.toContain("safe edit");
    expect(inspect.raw).toContain("safe edit");
    expect(() => resolve(a, "not-active", { branchId: "safe" })).toThrow("not an active conflict branch");
    const result = resolve(a, "resolved", { branchId: "right" });
    expect(a.view("doc").raw).toContain("right");
    expect(a.view("doc").raw).toContain("safe edit");
    expect(decode(a.view("doc").raw).metadata).toEqual(metadata);
    expect(a.view("doc").revision).toBe(result.revision);
    expect(a.view("doc").conflicts).toEqual([]);
    const resolution = a.pending()[0];
    expect(resolution).toMatchObject({ kind: "resolve", base: ["left", "right", "safe"], target: "right", content: null });
    const post = a.commit(edit(a, "post", "Beta", beta("sequential")));
    relay.push([post, resolution, safe, right, left]);
    const page = relay.pull("relay");
    b.receive(page); b.receive(page);
    expect(relay.push([resolution])[0].id).toBe("resolved");
    expect(b.view("doc")).toEqual(a.view("doc"));
    expect(b.view("doc").raw).toContain("sequential");
    expect(b.db.query("SELECT id, raw, deleted FROM sync_versions ORDER BY id").all())
      .toEqual(a.db.query("SELECT id, raw, deleted FROM sync_versions ORDER BY id").all());
    expect(b.operations()).toHaveLength(5);
    expect(a.db.query("SELECT operation_id FROM versions ORDER BY operation_id").all()).toEqual([
      { operation_id: "old" }, { operation_id: "seed" },
    ]);
  });
}

test("a conflict token guards the exact causal state even when raw and conflict pairs are unchanged", () => {
  const a = device();
  const left = edit(a, "left", "Alpha", alpha("left"));
  const right = edit(a, "right", "Alpha", alpha("right"));
  const noChange = edit(a, "no-change", "Beta", beta("old B"));
  a.push([left, right]);
  const before = a.inspect("doc");
  a.push([noChange]);
  const after = a.inspect("doc");
  expect(after.revision).toBe(before.revision);
  expect(after.conflicts).toEqual(before.conflicts);
  expect(after.conflictToken).not.toBe(before.conflictToken);
  expect(() => resolve(a, "stale", { branchId: "left" }, before)).toThrow("Conflict state changed");
  expect(() => resolve(a, "wrong-revision", { branchId: "left" }, { ...after, revision: "0".repeat(64) })).toThrow("Conflict state changed");
  expect(a.pending()).toEqual([]);
  expect(a.inspect("doc")).toEqual(after);
  resolve(a, "manual", { content: body }, after);
  expect(a.inspect("doc").revision).toBe(before.revision);
  expect(a.inspect("doc").conflictToken).not.toBe(after.conflictToken);
  expect(a.inspect("doc").conflicts).toEqual([]);
});

test("multiple pairs or dependent edits require a manual merge and keep all branch history", () => {
  const a = device(), b = device();
  const left = a.commit(edit(a, "left", "Alpha", alpha("left")));
  const descendant = a.commit(edit(a, "dependent", "Beta", beta("dependent")));
  const right = edit(b, "right", "Child", "### Child\nright\n");
  a.push([right]);
  expect(a.inspect("doc").conflicts).toEqual([["left", "right"]]);
  expect(a.inspect("doc").branches.map(({ operationId }) => operationId)).toEqual(["dependent", "left", "right"]);
  expect(() => resolve(a, "automatic", { branchId: "left" })).toThrow("dependent edits");
  const beta1 = edit(b, "beta1", "Beta", beta("beta 1")), beta2 = edit(b, "beta2", "Beta", beta("beta 2"));
  a.push([beta1, beta2]);
  expect(a.inspect("doc").conflicts.map((pair) => pair.join("/"))).toContain("beta1/beta2");
  expect(() => resolve(a, "automatic", { branchId: "dependent" })).toThrow("explicit merged Markdown");
  const merged = body.replace("old A", "left").replace("old child", "right").replace("old B", "manual merge");
  resolve(a, "manual", { content: merged });
  expect(a.view("doc").raw).toBe(encode(metadata, merged));
  expect(a.inspect("doc").conflicts).toEqual([]);
  b.push([a.pending().find(({ id }) => id === "manual"), beta2, beta1, descendant, right, left]);
  expect(b.inspect("doc")).toEqual(a.inspect("doc"));
  expect(b.db.query("SELECT count(*) AS n FROM sync_versions").get().n).toBe(6);
});

test("snapshot selection refuses a branch missing a visible edit", () => {
  const a = device(), b = device();
  a.commit(edit(a, "safe", "Beta", beta("safe edit")));
  a.commit(a.prepare({ id: "left", document: "doc", kind: "full", content: a.view("doc").raw.replace("intro", "full edit") }));
  a.push([edit(b, "right", "Alpha", alpha("right"))]);
  expect(a.inspect("doc").conflicts).toEqual([["left", "right"]]);
  expect(a.inspect("doc").raw).toContain("safe edit");
  expect(() => resolve(a, "loss", { branchId: "right" })).toThrow("may discard visible edits");
  expect(a.view("doc").raw).toContain("safe edit");
  resolve(a, "merged", { content: body.replace("old A", "right").replace("old B", "safe edit") });
  expect(a.view("doc").raw).toContain("right");
  expect(a.view("doc").raw).toContain("safe edit");
});

test("a parent graft refuses to erase a visible child edit outside the overlap between the arms", () => {
  const a = device(), b = device();
  const setup = a.commit(a.prepare({ id: "setup", document: "doc", kind: "full",
    content: raw.replace("## Beta", "### Sibling\nold sibling\n## Beta") }));
  b.push([setup]);
  a.commit(edit(a, "safe", "Child", "### Child\nsafe child edit\n"));
  a.commit(edit(a, "parent", "Alpha", alpha("parent edit") + "### Sibling\nold sibling\n"));
  a.push([edit(b, "sibling", "Sibling", "### Sibling\nchanged sibling\n")]);
  expect(a.inspect("doc").conflicts).toEqual([["parent", "sibling"]]);
  expect(() => resolve(a, "loss", { branchId: "parent" })).toThrow("may discard visible edits");
  resolve(a, "keep-safe", { branchId: "sibling" });
  expect(a.view("doc").raw).toContain("safe child edit");
  expect(a.view("doc").raw).toContain("changed sibling");
});

test("concurrent resolutions and late edits create new pairs and converge without erasing any branch", () => {
  const a = device(), b = device(), reverse = device();
  const left = edit(a, "left", "Alpha", alpha("left"));
  const right = edit(a, "right", "Alpha", alpha("right"));
  const late = edit(a, "late", "Beta", beta("unseen safe until resolution"));
  a.push([left, right]); b.push([right, left]);
  resolve(a, "resolved-a", { branchId: "left" });
  resolve(b, "resolved-b", { branchId: "right" });
  const [first] = a.pending(), [second] = b.pending();
  const post = a.commit(edit(a, "post", "Child", "### Child\npost resolution edit\n"));
  a.push([second, late]); b.push([late, post, first]); reverse.push([post, late, second, first, left, right]);
  const inspect = a.inspect("doc");
  expect(b.inspect("doc")).toEqual(inspect); expect(reverse.inspect("doc")).toEqual(inspect);
  expect(inspect.raw).toBe(raw);
  expect(inspect.conflicts).toEqual([["late", "resolved-a"], ["late", "resolved-b"], ["post", "resolved-b"], ["resolved-a", "resolved-b"]]);
  expect(inspect.branches.find(({ operationId }) => operationId === "post").raw).toContain("post resolution edit");
  expect(() => resolve(a, "no", { branchId: "left" })).toThrow("not an active conflict branch");
  expect(() => resolve(a, "no", { branchId: "resolved-b" })).toThrow("explicit merged Markdown");
  const merged = body.replace("old A", "chosen edit").replace("old B", "unseen safe until resolution");
  resolve(a, "reconciled", { content: merged });
  b.push([a.pending().find(({ id }) => id === "reconciled")]);
  expect(b.inspect("doc")).toEqual(a.inspect("doc"));
  expect(b.view("doc").raw).toBe(encode(metadata, merged));
  expect(b.view("doc").conflicts).toEqual([]);
  expect(b.db.query("SELECT count(*) AS n FROM sync_versions").get().n).toBe(7);
});

test("late overlapping edits reopen only new pairs, including pairs with previously resolved arms", () => {
  const a = device(), b = device();
  const left = edit(a, "left", "Alpha", alpha("left"));
  const right = edit(a, "right", "Alpha", alpha("right"));
  const late = edit(a, "late", "Child", "### Child\nlate\n");
  a.push([left, right]);
  resolve(a, "resolution", { branchId: "left" });
  const [resolution] = a.pending();
  a.push([late]); b.push([late, right]); b.push([resolution, left]);
  expect(a.inspect("doc")).toEqual(b.inspect("doc"));
  expect(b.inspect("doc").conflicts).toEqual([["late", "left"], ["late", "resolution"], ["late", "right"]]);
  expect(b.inspect("doc").branches.map(({ operationId }) => operationId)).toEqual(["late", "left", "resolution", "right"]);
  expect(b.view("doc").raw).toBe(raw);
});

test("full-branch resolution preserves the visible metadata, and remains hidden after a late tombstone", () => {
  const a = device(), b = device();
  const left = a.prepare({ id: "left", document: "doc", kind: "full", content: encode({ ...metadata, custom: "branch value" }, body.replace("intro", "full edit")) });
  const right = edit(a, "right", "Alpha", alpha("right"));
  a.push([left, right]);
  resolve(a, "resolved", { branchId: "left" });
  expect(a.view("doc").raw).toBe(encode(metadata, body.replace("intro", "full edit")));
  b.push([right, left, a.pending()[0]]);
  const deletion = b.prepare({ id: "delete", document: "doc", kind: "delete" });
  const stale = edit(b, "stale", "Beta", beta("offline edit after resolution"));
  a.push([deletion, stale]); b.push([stale, deletion]);
  expect(a.inspect("doc")).toEqual(b.inspect("doc"));
  expect(a.inspect("doc")).toMatchObject({ deleted: true, conflicts: [["delete", "stale"]] });
  expect(a.inspect("doc").branches.find(({ operationId }) => operationId === "delete").deleted).toBe(true);
  expect(() => resolve(a, "restore", { branchId: "stale" })).toThrow("Tombstone recovery");
  expect(() => resolve(a, "restore", { content: body })).toThrow("Tombstone recovery");
  expect(a.db.query("SELECT raw, deleted FROM sync_versions WHERE id = 'resolved'").get()).toEqual({
    raw: encode(metadata, body.replace("intro", "full edit")), deleted: 0,
  });
  const c = device();
  const offlineDeletion = c.prepare({ id: "offline-delete", document: "doc", kind: "delete" });
  c.push([offlineDeletion]); c.push([a.pending()[0], left, right]);
  expect(c.inspect("doc").deleted).toBe(true);
  expect(c.inspect("doc").conflicts).toContainEqual(["offline-delete", "resolved"]);
  expect(c.inspect("doc").branches.find(({ operationId }) => operationId === "resolved").raw).toContain("full edit");
});

test("malformed and falsely based resolution operations roll back complete pages", () => {
  const a = device(), b = device();
  const left = edit(a, "left", "Alpha", alpha("left"));
  const right = edit(a, "right", "Alpha", alpha("right"));
  a.push([left, right]);
  resolve(a, "resolution", { branchId: "left" });
  const [good] = a.pending();
  for (const [change, message] of [
    [{ target: "missing" }, "not an active conflict branch"],
    [{ base: ["left"] }, "requires active conflicts"],
    [{ target: null, content: "---\na: replaced\n---\nbody" }, "Malformed operation"],
    [{ content: body }, "Malformed operation"],
  ]) {
    expect(() => b.receive({ stream: "relay", after: 0, entries: [left, right, { ...good, ...change }]
      .map((operation, index) => ({ operation, sequence: index + 1 })) })).toThrow(message);
    for (const table of ["sync_operations", "sync_versions", "sync_outbox", "sync_conflicts", "sync_log", "sync_inbox", "sync_cursor"]) {
      expect(b.db.query(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(0);
    }
    expect(b.view("doc").raw).toBe(raw);
  }
  b.push([left, right, good]);
  expect(b.view("doc")).toEqual(a.view("doc"));
});

test("malformed mixed batch and missing dependency roll back apply/history/outbox/log/cursor", () => {
  const a = device(), b = device();
  const op = a.commit(edit(a, "a", "Beta", beta("first")));
  const later = a.commit(edit(a, "b", "Beta", beta("later")));
  const before = b.view("doc");
  const invalid = { ...later, target: "missing" };
  expect(() => b.receive({ stream: "relay", after: 0, entries: [{ sequence: 1, operation: op }, { sequence: 2, operation: invalid }] })).toThrow("Unknown section");
  expect(b.operations()).toEqual([]); expect(b.view("doc")).toEqual(before);
  for (const table of ["sync_versions", "sync_outbox", "sync_log", "sync_inbox", "sync_cursor"]) expect(b.db.query(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(0);
  expect(() => b.push([later])).toThrow("Missing dependencies");
  b.push([later, op]); expect(b.view("doc").raw).toContain("later");
});

test("injected persistence failure rolls back local mutation and remote cursor/outbox acknowledgement", () => {
  const a = device(), relay = device();
  const op = edit(a, "a", "Beta", beta("changed"));
  a.db.exec("CREATE TRIGGER fail_view BEFORE INSERT ON sync_views BEGIN SELECT RAISE(ABORT, 'synthetic crash'); END;");
  expect(() => a.commit(op)).toThrow("synthetic crash");
  expect(a.pending()).toEqual([]); expect(a.operations()).toEqual([]);
  a.db.exec("DROP TRIGGER fail_view"); a.commit(op); relay.push([op]);
  a.db.exec("CREATE TRIGGER fail_cursor BEFORE INSERT ON sync_cursor BEGIN SELECT RAISE(ABORT, 'synthetic crash'); END;");
  expect(() => a.receive(relay.pull("relay"))).toThrow("synthetic crash");
  expect(a.pending()).toHaveLength(1); expect(a.db.query("SELECT * FROM sync_inbox").all()).toEqual([]);
  a.db.exec("DROP TRIGGER fail_cursor"); a.receive(relay.pull("relay")); expect(a.pending()).toEqual([]);
});

test("pagination restart, cursor gaps, rewritten sequence and wrong stream fail safely", () => {
  const a = device(), b = device(), relay = device();
  a.commit(edit(a, "a", "Alpha", alpha("A"))); a.commit(edit(a, "b", "Beta", beta("B")));
  relay.push(a.pending());
  expect(() => b.receive(relay.pull("relay", 1, 1))).toThrow("cursor gap");
  b.receive(relay.pull("relay", 0, 1));
  const reopened = new Database(b.filename); connections.push(reopened);
  const restarted = new SyncPrototype(reopened);
  restarted.receive(relay.pull("relay", 1, 1)); restarted.receive(relay.pull("relay", 0, 1));
  expect(restarted.view("doc")).toEqual(a.view("doc"));
  expect(reopened.query("SELECT position FROM sync_cursor").get().position).toBe(2);
  expect(() => restarted.receive(relay.pull("wrong", 2))).toThrow("Stream mismatch");
  const page = relay.pull("relay"); page.entries.reverse();
  expect(() => restarted.receive(page)).toThrow("Noncontiguous");
  page.entries = [{ sequence: 1, operation: a.operations().find((op) => op.id === "b") }];
  expect(() => restarted.receive(page)).toThrow("Rewritten");
});

test("wrong space/genesis, unknown fields, invalid closure and oversized operations rejected", () => {
  const a = device(), b = device();
  const first = a.commit(edit(a, "first", "Beta", beta("first")));
  a.commit(edit(a, "second", "Beta", beta("second")));
  const third = edit(a, "third", "Beta", beta("third"));
  for (const changed of [{ space: "wrong" }, { genesis: "wrong" }, { extra: true }, { base: ["z", "a"] }, { content: "x".repeat(1_000_001) }]) {
    expect(() => b.push([{ ...first, ...changed }])).toThrow("Malformed");
  }
  b.push(a.operations());
  expect(() => b.push([{ ...third, base: ["second"] }])).toThrow("closure");
  expect(() => b.push([{ ...third, document: "absent" }])).toThrow("Unknown document");
  expect(() => b.push(Array(101).fill(first))).toThrow("batch size");
});

test("busy database rejects atomic mutation; exact retry succeeds after writer release", () => {
  const a = device();
  const other = new Database(a.filename); connections.push(other);
  const op = edit(a, "a", "Beta", beta("changed"));
  other.exec("BEGIN IMMEDIATE");
  expect(() => a.commit(op)).toThrow();
  expect(a.operations()).toEqual([]); expect(a.pending()).toEqual([]);
  other.exec("ROLLBACK"); a.commit(op); expect(a.pending()).toHaveLength(1);
});

test("abrupt process exit during receive recovers without partial history, acknowledgement or cursor", () => {
  const a = device(), relay = device();
  a.commit(edit(a, "a", "Beta", beta("changed"))); relay.push(a.pending());
  const module = path.resolve(import.meta.dir, "../config/chat/memory-plugin/sync-prototype.js");
  const script = `import { Database } from 'bun:sqlite';
    import { SyncPrototype } from ${JSON.stringify(module)};
    const db = new Database(${JSON.stringify(a.filename)});
    db.function('crash', () => process.exit(17));
    db.exec("CREATE TEMP TRIGGER crash_cursor BEFORE INSERT ON sync_cursor BEGIN SELECT crash(); END;");
    new SyncPrototype(db).receive(${JSON.stringify(relay.pull("relay"))});`;
  const result = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8" });
  expect(result.status).toBe(17);
  expect(a.pending()).toHaveLength(1);
  expect(a.db.query("SELECT * FROM sync_cursor").all()).toEqual([]);
  expect(a.db.query("SELECT * FROM sync_inbox").all()).toEqual([]);
  a.receive(relay.pull("relay")); expect(a.pending()).toEqual([]);
  expect(a.db.query("PRAGMA integrity_check").get().integrity_check).toBe("ok");
});

test("same operation at two sequence numbers is rejected with full page rollback", () => {
  const a = device(), b = device();
  const op = a.commit(edit(a, "a", "Beta", beta("changed")));
  const page = { stream: "relay", after: 0, entries: [{ sequence: 1, operation: op }, { sequence: 2, operation: op }] };
  expect(() => b.receive(page)).toThrow("different stream sequence");
  expect(b.operations()).toEqual([]); expect(b.db.query("SELECT * FROM sync_cursor").all()).toEqual([]);
  b.receive({ ...page, entries: page.entries.slice(0, 1) });
  expect(() => b.receive({ ...page, after: 1, entries: page.entries.slice(1) })).toThrow("different stream sequence");
});

test("independent concurrent edit stays visible beside preserved conflicting branches", () => {
  const a = device(), b = device(), c = device(), relay = device();
  a.commit(edit(a, "a", "Alpha", alpha("left")));
  b.commit(edit(b, "b", "Child", "### Child\nright\n"));
  c.commit(edit(c, "c", "Beta", beta("independent")));
  relay.push([...a.pending(), ...b.pending(), ...c.pending()]);
  expect(relay.view("doc").conflicts).toHaveLength(1);
  expect(relay.view("doc").raw).toContain("independent");
  expect(relay.view("doc").raw).toContain("old child");
});
