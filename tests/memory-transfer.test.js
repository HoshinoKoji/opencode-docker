import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../config/chat/memory-plugin/cli.js";
import { importMarkdown, exportMarkdown } from "../config/chat/memory-plugin/transfer.js";
import { createMemoryStore } from "../config/chat/memory-plugin/backend.js";
import { SQLiteMemoryStore } from "../config/chat/memory-plugin/sqlite.js";
import { encode } from "../config/chat/memory-plugin/format.js";
import plugin from "../config/chat/memory-plugin/index.js";
import { parseOptions } from "../config/chat/memory-mcp/options.js";

const roots = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-transfer-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const raw = (id, type = "long_term") => encode({ schema_version: 1, id, type, date: "2026-01-01", topic: "test", summary: "summary", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", custom: { preserved: true } }, "# 中文\n## Detail\nbytes  \n").replaceAll("\n", "\r\n");
async function seed(root, scope = "shared", content = raw("stable"), name = "MEMORY.md") {
  const directory = path.join(root, scope === "shared" ? ".sessions" : ".sessions/casual");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), content);
}

test("Git-backed memory imports skip administration artifacts without hiding invalid documents", async () => {
  const source = await fixture(), root = await fixture();
  await seed(source);
  await seed(source, "private", raw("private"));
  await mkdir(path.join(source, ".sessions/.git"));
  await writeFile(path.join(source, ".sessions/.git/config"), "untouched");
  await writeFile(path.join(source, ".sessions/casual/.git"), "gitdir: /unread/external");
  for (const dir of [".sessions", ".sessions/casual"]) {
    for (const name of [".gitignore", ".gitattributes", ".gitmodules"]) await writeFile(path.join(source, dir, name), "untouched");
  }
  const preview = await importMarkdown({ root, source, scope: "both", dryRun: true });
  expect(preview.spaces.map((s) => s.documents)).toEqual([1, 1]);
  expect(await readdir(root)).toEqual([]);
  await importMarkdown({ root, source, scope: "both" });
  expect(await readFile(path.join(source, ".sessions/.git/config"), "utf8")).toBe("untouched");
  await writeFile(path.join(source, ".sessions/notes.md"), "must not silently skip");
  await expect(importMarkdown({ root, source, dryRun: true })).rejects.toThrow("Unsupported import entry: .sessions/notes.md");
});

test("init is explicit, scoped, idempotent; empty reads/dry runs never initialize", async () => {
  const root = await fixture();
  await run(["recall", "--root", root], {});
  await run(["init", "--root", root, "--dry-run", "--space", "both"], {});
  expect(await readdir(root)).toEqual([]);
  await run(["init", "--root", root], {});
  const filename = path.join(root, ".memory-db/shared.sqlite");
  const original = await readFile(filename);
  await run(["init", "--root", root], {});
  expect(await readFile(filename)).toEqual(original);
  expect(await readdir(path.dirname(filename))).toEqual(["shared.sqlite"]);
  await expect(run(["recall"], {})).rejects.toThrow("absolute");
  expect(() => createMemoryStore(root, { backend: "markdown" })).toThrow("Only the sqlite");
});

test("import/export preserve exact bytes, IDs, metadata, revisions and safe retries across both spaces", async () => {
  const source = await fixture(), root = await fixture(), output = path.join(await fixture(), "export");
  await seed(source);
  await seed(source, "shared", "# Legacy session\n中文\n", "2026-01-01-legacy.md");
  await seed(source, "private", raw("private"));
  const dry = await run(["migrate", "--source", source, "--root", root, "--space", "both", "--dry-run"], {});
  expect(dry.result.spaces.map((s) => s.documents)).toEqual([2, 1]);
  expect(await readdir(root)).toEqual([]);
  await importMarkdown({ root, source, scope: "both" });
  const db = new Database(path.join(root, ".memory-db/shared.sqlite"));
  const before = db.query("SELECT * FROM versions").all();
  await importMarkdown({ root, source, scope: "both" });
  expect(db.query("SELECT * FROM versions").all()).toEqual(before);
  expect(db.query("SELECT raw FROM documents WHERE name = 'MEMORY.md'").get().raw).toBe(raw("stable"));
  db.close();
  const read = (await createMemoryStore(root).read("build", { name: "MEMORY.md" })).results[0];
  expect(read.metadata.id).toBe("stable");
  expect(read.metadata.custom).toEqual({ preserved: true });
  await exportMarkdown({ root, destination: output, scope: "both", dryRun: true });
  expect(await readdir(path.dirname(output))).toEqual([]);
  await exportMarkdown({ root, destination: output, scope: "both" });
  for (const file of [".sessions/MEMORY.md", ".sessions/2026-01-01-legacy.md", ".sessions/casual/MEMORY.md"]) {
    expect(await readFile(path.join(output, file))).toEqual(await readFile(path.join(source, file)));
  }
  const restored = await fixture();
  await importMarkdown({ root: restored, source: output, scope: "both" });
  expect(await createMemoryStore(restored).read("build", { name: "MEMORY.md" })).toEqual(await createMemoryStore(root).read("build", { name: "MEMORY.md" }));
  await expect(exportMarkdown({ root, destination: output })).rejects.toThrow("must not exist");
});

test("all selected spaces preflight before import; duplicates and destination conflicts preserve existing data", async () => {
  const source = await fixture(), root = await fixture();
  await seed(source);
  await seed(source, "private", raw("dup"));
  await seed(source, "private", raw("dup", "session"), "2026-01-01-duplicate.md");
  await expect(importMarkdown({ root, source, scope: "both" })).rejects.toThrow("Duplicate");
  expect(await readdir(root)).toEqual([]);
  await importMarkdown({ root, source }); // Shared-only never reads private duplicates.
  await seed(source, "shared", raw("changed"));
  await expect(importMarkdown({ root, source })).rejects.toThrow("Destination conflict");
  expect((await createMemoryStore(root).read("build", { name: "MEMORY.md" })).results[0].metadata.id).toBe("stable");
});

test("mid-import failure rolls back documents, versions and outbox within the space", async () => {
  const source = await fixture(), root = await fixture();
  await seed(source);
  await seed(source, "shared", raw("session", "session"), "2026-01-01-session.md");
  const atomic = SQLiteMemoryStore.prototype.atomic;
  let writes = 0;
  SQLiteMemoryStore.prototype.atomic = async function (...args) {
    await atomic.apply(this, args);
    if (++writes === 2) throw new Error("injected failure");
  };
  try { await expect(importMarkdown({ root, source })).rejects.toThrow("injected failure"); }
  finally { SQLiteMemoryStore.prototype.atomic = atomic; }
  const db = new Database(path.join(root, ".memory-db/shared.sqlite"));
  for (const table of ["documents", "versions", "outbox"]) expect(db.query(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(0);
  db.close();
  await importMarkdown({ root, source });
  expect((await createMemoryStore(root).recall("build")).spaces[0].recent).toHaveLength(1);
});

test("source conflicts, unsafe filenames, symlinks and invalid UTF-8 fail without changes", async () => {
  const source = await fixture(), root = await fixture();
  await seed(source);
  await writeFile(path.join(source, "MEMORY.md"), "legacy");
  await expect(importMarkdown({ root, source })).rejects.toThrow("conflict");
  await rm(path.join(source, "MEMORY.md"));
  await seed(source, "shared", "bad", "unsafe.md");
  await expect(importMarkdown({ root, source })).rejects.toThrow("Unsupported import entry: .sessions/unsafe.md");
  await rm(path.join(source, ".sessions/unsafe.md"));
  await symlink(path.join(source, ".sessions/MEMORY.md"), path.join(source, ".sessions/2026-01-01-link.md"));
  await expect(importMarkdown({ root, source })).rejects.toThrow("symlinks");
  await rm(path.join(source, ".sessions/2026-01-01-link.md"));
  await seed(source, "shared", Buffer.from([0xff]));
  await expect(importMarkdown({ root, source })).rejects.toThrow("UTF-8");
  const link = path.join(await fixture(), "root-link");
  await symlink(source, link);
  await expect(importMarkdown({ root, source: link })).rejects.toThrow("symlinks");
  expect(await readdir(root)).toEqual([]);
});

test("legacy-root and empty documents retain raw bytes and database IDs through later updates", async () => {
  const source = await fixture(), root = await fixture();
  await writeFile(path.join(source, "MEMORY.md"), "");
  await importMarkdown({ root, source });
  const db = new Database(path.join(root, ".memory-db/shared.sqlite"));
  const original = db.query("SELECT id, raw FROM documents").get();
  expect(original.raw).toBe("");
  const store = createMemoryStore(root);
  const before = (await store.read("build", { name: "MEMORY.md" })).results[0];
  await store.update("build", { content: "new preference", expectedRevision: before.revision });
  expect((await store.read("build", { name: "MEMORY.md" })).results[0].metadata.id).toBe(original.id);
  expect(db.query("SELECT DISTINCT document_id FROM versions").all()).toEqual([{ document_id: original.id }]);
  db.close();
  expect(await readFile(path.join(source, "MEMORY.md"), "utf8")).toBe("");
});

test("every runtime entrypoint rejects Markdown; shared export never opens a private database", async () => {
  const root = await fixture();
  await expect(run(["recall", "--root", root, "--backend", "markdown"], {})).rejects.toThrow("Only the sqlite");
  expect(() => parseOptions(["--root", root, "--backend", "markdown"], {})).toThrow("Only the sqlite");
  await expect(plugin.setup({ options: { root, backend: "markdown" } })).rejects.toThrow("Only the sqlite");
  await run(["init", "--root", root], {});
  await symlink("/nonexistent-private-target", path.join(root, ".memory-db/private.sqlite"));
  const destination = path.join(await fixture(), "export");
  expect((await exportMarkdown({ root, destination })).documents).toBe(0);
  await expect(exportMarkdown({ root, destination: path.join(await fixture(), "export"), scope: "both" })).rejects.toThrow("symlinks");
});

test("late second-space failure rolls that space back; retry finishes without duplicating the first", async () => {
  const root = await fixture(), source = await fixture();
  await seed(source);
  await seed(source, "private", raw("private"));
  const atomic = SQLiteMemoryStore.prototype.atomic;
  SQLiteMemoryStore.prototype.atomic = async function (...args) {
    await atomic.apply(this, args);
    if (this.transaction.getStore().scope === "private") throw new Error("private failure");
  };
  try { await expect(importMarkdown({ root, source, scope: "both" })).rejects.toThrow("private failure"); }
  finally { SQLiteMemoryStore.prototype.atomic = atomic; }
  const store = createMemoryStore(root);
  expect((await store.read("build", { name: "MEMORY.md" })).results[0].metadata.id).toBe("stable");
  expect((await store.read("casual", { name: "MEMORY.md", scope: "private" })).results[0].text).toBe("");
  await importMarkdown({ root, source, scope: "both" });
  for (const scope of ["shared", "private"]) {
    const db = new Database(path.join(root, `.memory-db/${scope}.sqlite`));
    expect(db.query("SELECT count(*) AS n FROM versions").get().n).toBe(1);
    db.close();
  }
});
