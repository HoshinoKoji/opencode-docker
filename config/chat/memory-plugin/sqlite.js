import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { chmodSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MemoryStore, sessionMetadata } from "./store.js";
import { decode, legacyMetadata, SESSION_FILENAME } from "./format.js";
import { SyncPrototype } from "./sync-prototype.js";
import { transportMarker } from "./sync-role.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");

// Persistence adapter: keep the public Markdown contract (including byte-based
// revisions), with raw documents authoritative inside SQLite, never on disk.
export class SQLiteMemoryStore extends MemoryStore {
  transaction = new AsyncLocalStorage();

  constructor(root) {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("SQLite memory requires an explicit absolute root.");
    super(root);
  }

  async checked(relative) {
    // Check root ancestors as well as database paths; an explicit root must not
    // silently redirect through a symlink.
    let current = path.parse(this.root).root;
    for (const segment of this.root.slice(current.length).split(path.sep)) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Memory root symlinks are unsupported.");
    }
    return super.checked(relative);
  }

  async init(scope) {
    const db = await this.open(scope, true);
    db.close();
    return { scope, initialized: true };
  }

  async updateMetadata(scope, document, now) {
    if (document.metadata) return document.metadata;
    const prior = await this.connection(scope, (db) => this.rows(db).find((row) => row.name === "MEMORY.md"));
    // A plain imported document already has a deterministic database identity.
    // Keep it when its first normal update introduces frontmatter.
    return prior ? { ...legacyMetadata(scope, "MEMORY.md", document.body), id: prior.id }
      : super.updateMetadata(scope, document, now);
  }

  async open(scope, writing = false, { requireSync = false } = {}) {
    this.relative(scope, "MEMORY.md");
    const directory = await this.checked(".memory-db");
    const filename = await this.checked(`.memory-db/${scope}.sqlite`);
    for (const suffix of ["-wal", "-shm", "-journal"]) await this.checked(`.memory-db/${scope}.sqlite${suffix}`);
    try {
      if (!(await lstat(filename)).isFile()) throw new Error("Memory database must be a regular file.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (requireSync) throw new Error("Conflict administration requires an existing SQLite schema v2 space.");
      if (!writing) return null;
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const db = new Database(filename, { readonly: !writing, create: writing && !requireSync, strict: true });
    try {
      db.exec("PRAGMA busy_timeout = 100; PRAGMA foreign_keys = ON;");
      const version = db.query("PRAGMA user_version").get().user_version;
      if (requireSync && version !== 2) throw new Error("Conflict administration requires SQLite schema v2. Use upgrade-sync explicitly with writers stopped.");
      if (![0, 1, 2].includes(version)) throw new Error(`Unsupported memory database schema: ${version}.`);
      if (writing) {
        if (version === 2 && transportMarker(db)?.role === "relay") {
          throw new Error("Regular memory writes are disabled on a local sync relay.");
        }
        chmodSync(filename, 0o600);
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
        if (version === 0) {
          db.transaction(() => {
            // Another process may have initialized while BEGIN waited.
            const current = db.query("PRAGMA user_version").get().user_version;
            if (current === 1) return;
            if (current !== 0) throw new Error(`Unsupported memory database schema: ${current}.`);
            if (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()) {
              throw new Error("Refusing to initialize a nonempty unversioned database.");
            }
            db.exec(`
              CREATE TABLE store_info (scope TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS documents (
                name TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, raw TEXT NOT NULL,
                revision TEXT NOT NULL, head TEXT NOT NULL
              );
              CREATE TABLE IF NOT EXISTS versions (
                operation_id TEXT PRIMARY KEY, document_id TEXT NOT NULL,
                parent TEXT, revision TEXT NOT NULL, raw TEXT NOT NULL,
                created_at TEXT NOT NULL
              );
              CREATE TABLE IF NOT EXISTS outbox (
                operation_id TEXT PRIMARY KEY REFERENCES versions(operation_id)
              );
              PRAGMA user_version = 1;
            `);
            db.query("INSERT INTO store_info VALUES (?)").run(scope);
          }).immediate();
        }
      } else if (version === 0) throw new Error("Memory database is uninitialized.");
      if (db.query("SELECT scope FROM store_info").get()?.scope !== scope) throw new Error("Memory database space mismatch.");
      return db;
    } catch (error) { db.close(); throw error; }
  }

  async connection(scope, fn) {
    const active = this.transaction.getStore();
    if (active) {
      if (active.scope !== scope) throw new Error("Cross-space transaction is unsupported.");
      return fn(active.db);
    }
    const db = await this.open(scope);
    try { return fn(db); } finally { db?.close(); }
  }

  async source(scope, name) { return this.relative(scope, name); }

  location(relative) {
    const name = path.basename(relative);
    const scope = relative.startsWith(".sessions/casual/") ? "private" : "shared";
    if (this.relative(scope, name) !== relative) throw new Error("Invalid memory document path.");
    return { scope, name };
  }

  async text(relative) {
    const { scope, name } = this.location(relative);
    return this.connection(scope, (db) => this.rows(db).find((row) => row.name === name)?.raw ?? "");
  }

  rows(db) {
    if (!db) return [];
    return db.query(db.query("PRAGMA user_version").get().user_version === 2
      ? "SELECT s.name, s.id, v.raw, v.revision FROM sync_seed s JOIN sync_views v ON s.id = v.id WHERE v.deleted = 0 ORDER BY s.name DESC"
      : "SELECT name, id, raw, revision FROM documents ORDER BY name DESC").all();
  }

  async names(scope) {
    return this.connection(scope, (db) => ["MEMORY.md", ...this.rows(db).filter((row) => row.name !== "MEMORY.md").map((row) => row.name)]);
  }

  async rebuild(scope) { return this.relative(scope, "INDEX.md"); }
  async relocateShared() { /* SQLite never discovers or migrates Markdown. */ }

  assertWritable(db, name, id = null) {
    if (db?.query("PRAGMA user_version").get().user_version !== 2) return;
    const blocked = db.query(`
      SELECT v.deleted FROM sync_seed s JOIN sync_views v USING (id)
      WHERE (s.name = ? OR s.id = ?) AND (v.deleted = 1 OR
        EXISTS (SELECT 1 FROM sync_conflicts c WHERE c.document = s.id))
      ORDER BY v.deleted DESC LIMIT 1
    `).get(name, id);
    if (blocked?.deleted) throw new Error(`Document is deleted; explicit restoration is required: ${name}.`);
    if (blocked) throw new Error(`Document requires explicit conflict resolution; runtime writes are blocked: ${name}.`);
  }

  async sessionForWrite(scope, name, id) {
    return this.connection(scope, (db) => {
      this.assertWritable(db, name, id);
      return this.rows(db).find((row) => row.name === name);
    });
  }

  async delete(agent, { name, expectedRevision, scope = "default", share = false }) {
    const [space] = this.scopes(agent, scope, true, share === true);
    if (typeof name !== "string" || !SESSION_FILENAME.test(name)) {
      throw new Error("Delete requires a session record filename without directories; MEMORY.md and INDEX.md are protected.");
    }
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      throw new Error("Delete requires expectedRevision from a read of the session record.");
    }
    // Fail before opening a writer on an uninitialized or v1 space. Only the
    // explicit upgrade can enable deletion and its durable sync history.
    await this.connection(space, (db) => {
      if (db?.query("PRAGMA user_version").get().user_version !== 2) {
        throw new Error("Session record deletion requires SQLite schema v2. An operator can use upgrade-sync with all writers stopped.");
      }
    });
    return this.locked(async () => {
      const row = await this.sessionForWrite(space, name);
      if (!row) throw new Error(`Session record not found: ${name}.`);
      if (row.revision !== expectedRevision) throw new Error(`Memory changed since it was read. Read ${name} again before deleting.`);
      sessionMetadata(space, name, decode(row.raw), row.id);
      const sync = new SyncPrototype(this.transaction.getStore().db);
      sync.commit(sync.prepare({ id: randomUUID(), document: row.id, kind: "delete" }));
      // The tombstone and its retained branch snapshot live in sync_versions;
      // the legacy history has no deleted flag and remains untouched.
      return { scope: space, name, logicalPath: this.relative(space, name), id: row.id, deleted: true };
    }, space);
  }

  async atomic(relative, raw, { section } = {}) {
    const { scope, name } = this.location(relative);
    const active = this.transaction.getStore();
    if (!active || active.scope !== scope) throw new Error("SQLite writes require a space transaction.");
    if (name === "INDEX.md") throw new Error("SQLite indexes are derived.");
    const document = decode(raw);
    const metadata = document.metadata ?? legacyMetadata(scope, name, document.body);
    const db = active.db;
    const operation = randomUUID();
    const v2 = db.query("PRAGMA user_version").get().user_version === 2;
    if (v2) {
      this.assertWritable(db, name, metadata.id);
      const sync = new SyncPrototype(db);
      const seed = db.query("SELECT id FROM sync_seed WHERE name = ?").get(name);
      if (seed && seed.id !== metadata.id) throw new Error("Document metadata identity changed.");
      const view = seed ? sync.view(seed.id) : null;
      if (view?.raw === raw) return;
      const edit = view && section !== undefined
        ? sync.prepareSectionUpdate({ id: operation, document: metadata.id, section, raw, view }) : null;
      if (edit) {
        if (view.raw === edit.raw) return edit.raw;
        sync.commit(edit.op);
        raw = db.query("SELECT raw FROM sync_views WHERE id = ?").get(seed.id)?.raw;
        if (raw !== edit.raw) throw new Error("Section sync projection diverged from the local edit.");
      } else {
        sync.commit(sync.prepare({ id: operation, document: metadata.id, name,
          kind: seed ? "full" : "create", content: raw }));
      }
    }
    const prior = db.query("SELECT head, raw FROM documents WHERE name = ?").get(name);
    if (!v2 && prior?.raw === raw) return;
    const revision = hash(raw);
    db.query("INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)").run(operation, metadata.id, prior?.head ?? null, revision, raw, new Date().toISOString());
    // v1 pending entries are retained; v2 mutations enqueue only sync operations.
    if (!v2) db.query("INSERT INTO outbox VALUES (?)").run(operation);
    db.query(`INSERT INTO documents VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET id=excluded.id, raw=excluded.raw, revision=excluded.revision, head=excluded.head`).run(name, metadata.id, raw, revision, operation);
    return raw;
  }

  async locked(fn, scope) {
    const deadline = Date.now() + 5000;
    let db;
    for (;;) {
      try { db = await this.open(scope, true); break; }
      catch (error) {
        if (error.code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
        await delay(20);
      }
    }
    try {
      // Bun transaction callbacks must be synchronous. Explicit BEGIN/COMMIT
      // spans the inherited async operations on a dedicated connection. Yield
      // between busy attempts so another in-process writer can finish its await.
      for (;;) {
        try { db.exec("BEGIN IMMEDIATE"); break; }
        catch (error) {
          if (error.code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
          await delay(20);
        }
      }
      try {
        const result = await this.transaction.run({ db, scope }, fn);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw error;
      }
    } finally { db.close(); }
  }
}
