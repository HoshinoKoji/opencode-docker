import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { writeFile, open } from "node:fs/promises";
import { SQLiteMemoryStore } from "./sqlite.js";
import { migrateSyncV2 } from "./sync-prototype.js";
import { transportMarker } from "./sync-role.js";

// Explicit administration only: callers stop ALL writers, including old loaded
// plugin code. Ordinary open/init/read/write never invoke this function.
export async function upgradeSync({ root, scope = "shared", dryRun = false }) {
  const store = new SQLiteMemoryStore(root);
  const source = await store.open(scope);
  if (!source) throw new Error("Initialize the selected database before upgrading.");
  let snapshot;
  try {
    if (source.query("PRAGMA user_version").get().user_version === 2) return { scope, schema: 2, upgraded: false, dryRun };
    snapshot = source.serialize();
  } finally { source.close(); }
  const spaceId = randomUUID();
  // Validate all migration DDL/data against a disposable in-memory copy even
  // for dry-run; no sidecar or backup files are created by this preview.
  // sqlite3_deserialize cannot open a WAL-mode image. Serialization already
  // includes committed pages; set the in-memory copy's file-format read/write
  // versions to rollback mode (SQLite header bytes 18/19).
  snapshot = Buffer.from(snapshot);
  snapshot[18] = 1; snapshot[19] = 1;
  const preview = Database.deserialize(snapshot);
  try { migrateSyncV2(preview, { spaceId }); } finally { preview.close(); }
  if (dryRun) return { scope, schema: 1, targetSchema: 2, dryRun: true };
  const db = await store.open(scope, true);
  try {
    db.exec("BEGIN IMMEDIATE");
    if (db.query("PRAGMA user_version").get().user_version !== 1) throw new Error("Schema changed during upgrade; retry.");
    const databasePath = await store.checked(`.memory-db/${scope}.sqlite`);
    const backupPath = await store.checked(`.memory-db/${scope}.v1-${randomUUID()}.sqlite`);
    // serialize() captures a coherent SQLite snapshot including committed WAL.
    // Exclusive creation + fsync makes the standalone backup durable before DDL.
    await writeFile(backupPath, db.serialize(), { flag: "wx", mode: 0o600 });
    const backup = await open(backupPath, "r");
    try { await backup.sync(); } finally { await backup.close(); }
    const directory = await open(await store.checked(".memory-db"), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    migrateSyncV2(db, { spaceId });
    db.exec("COMMIT");
    return { scope, schema: 2, upgraded: true, dryRun: false, databasePath, backupPath, spaceId };
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}

export async function syncStatus({ root, scope = "shared" }) {
  const store = new SQLiteMemoryStore(root);
  return store.connection(scope, (db) => {
    if (!db) return { scope, schema: null };
    const schema = db.query("PRAGMA user_version").get().user_version;
    if (schema === 1) return { scope, schema, upgradeRequired: true };
    return db.transaction(() => {
      const marker = transportMarker(db);
      return { scope, schema, ...db.query("SELECT space, genesis FROM sync_info").get(),
        ...(marker ?? { role: "unbound" }),
        ...(marker?.role === "relay" ? db.query("SELECT coalesce(max(sequence), 0) AS head FROM sync_log").get() : {}),
        pending: db.query("SELECT count(*) AS count FROM sync_outbox").get().count,
        conflicts: db.query("SELECT * FROM sync_conflicts ORDER BY document, left_id, right_id").all(),
        tombstones: db.query("SELECT id FROM sync_views WHERE deleted = 1").all(),
        cursor: db.query("SELECT stream, position FROM sync_cursor").get() };
    })();
  });
}
