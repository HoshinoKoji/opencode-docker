import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { digest } from "./format.js";
import { SyncPrototype } from "./sync-prototype.js";
import { markTransport, transportMarker } from "./sync-role.js";
import { safeRoot } from "./transfer.js";

const sidecars = ["-wal", "-shm", "-journal"];
const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;

async function entry(filename) {
  try { return await lstat(filename, { bigint: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}

async function location(root, scope, empty = false) {
  await safeRoot(root);
  const directory = path.join(root, ".memory-db");
  const directoryInfo = await entry(directory);
  if (directoryInfo && !directoryInfo.isDirectory()) throw new Error("Memory database directory must be a real directory (no symlinks).");
  const filename = path.join(directory, `${scope}.sqlite`);
  const file = await entry(filename);
  for (const item of [file, ...await Promise.all(sidecars.map((suffix) => entry(filename + suffix)))]) {
    if (!item) continue;
    if (empty) throw new Error("Destination database and SQLite sidecars must not exist.");
    if (!item.isFile() || item.nlink !== 1n) throw new Error("Database and sidecars must be regular files without symlinks or hardlinks.");
  }
  if (!empty && !file) throw new Error("Local sync requires an existing SQLite schema v2 space.");
  return { root, rootInfo: await entry(root), directory, directoryInfo, filename, file };
}

async function endpoints(root, relayRoot, scope, empty) {
  if (!["shared", "private"].includes(scope)) throw new Error("Local sync requires one explicit space.");
  if (root === relayRoot) throw new Error("Device and relay must use distinct roots.");
  const device = await location(root, scope, empty === "device");
  const relay = await location(relayRoot, scope, empty === "relay");
  if (sameFile(device.rootInfo, relay.rootInfo) || sameFile(device.directoryInfo, relay.directoryInfo) || sameFile(device.file, relay.file)) {
    throw new Error("Device and relay must use distinct roots and databases.");
  }
  return { device, relay };
}

function access({ filename }, writing, fn) {
  const db = new Database(filename, { readonly: !writing, create: false, strict: true });
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 100;");
    if (writing) db.exec("PRAGMA synchronous = FULL;");
    const transaction = db.transaction(() => fn(db));
    return writing ? transaction.immediate() : transaction();
  } finally { db.close(); }
}

const logHead = (db) => db.query("SELECT coalesce(max(sequence), 0) AS head FROM sync_log").get().head;
const logEntry = (db, sequence) => db.query("SELECT id, payload FROM sync_log JOIN sync_operations USING (id) WHERE sequence = ?").get(sequence);
const pendingCount = (db) => db.query("SELECT count(*) AS n FROM sync_outbox").get().n;

function state(db, scope) {
  if (db.query("PRAGMA user_version").get().user_version !== 2) {
    throw new Error("Local sync requires SQLite schema v2. Use upgrade-sync explicitly with writers stopped.");
  }
  const scopes = db.query("SELECT scope FROM store_info").all();
  if (scopes.length !== 1 || scopes[0].scope !== scope) throw new Error("Memory database space mismatch.");
  const identities = db.query("SELECT space, genesis FROM sync_info").all();
  const identity = identities[0];
  if (identities.length !== 1 || !/^[A-Za-z0-9_.:-]{1,160}$/.test(identity.space) || !/^[a-f0-9]{64}$/.test(identity.genesis)) {
    throw new Error("Invalid local sync space identity or genesis.");
  }
  const marker = transportMarker(db);
  const cursor = db.query("SELECT stream, position FROM sync_cursor").get();
  const inbox = db.query("SELECT count(*) AS n, min(sequence) AS first, max(sequence) AS last FROM sync_inbox").get();
  if (marker?.role !== "device") {
    if (cursor || inbox.n || (marker?.role === "relay" && pendingCount(db))) {
      throw new Error("Unexpected cursor, inbox or outbox for this local sync role.");
    }
    return { ...identity, role: marker?.role ?? "unbound", stream: marker?.stream ?? null };
  }
  if (!cursor || cursor.stream !== marker.stream || !Number.isSafeInteger(cursor.position) || cursor.position < 0 ||
      inbox.n !== cursor.position || (inbox.n && (inbox.first !== 1 || inbox.last !== cursor.position))) {
    throw new Error("Local sync stream marker, cursor and inbox do not agree.");
  }
  const checkpoint = cursor.position ? db.query("SELECT id, payload FROM sync_inbox JOIN sync_operations USING (id) WHERE sequence = ?")
    .get(cursor.position) : null;
  if (cursor.position && !checkpoint) throw new Error("Local sync cursor is missing its received operation.");
  return { ...identity, ...marker, position: cursor.position, checkpoint };
}

function compatible(device, relay) {
  if (device.role === "relay" || relay.role !== "relay") throw new Error("Local sync requires a device and an explicitly marked relay.");
  if (device.space !== relay.space || device.genesis !== relay.genesis) throw new Error("Local sync space ID or genesis mismatch.");
  if (device.stream && device.stream !== relay.stream) throw new Error("Device is bound to a different local sync stream.");
}

function verifyRelay(db, scope, device) {
  const relay = state(db, scope);
  compatible(device, relay);
  const head = logHead(db);
  if (device.position) {
    const prior = logEntry(db, device.position);
    if (!prior || prior.id !== device.checkpoint.id || prior.payload !== device.checkpoint.payload) {
      throw new Error("Relay history does not match the device cursor; refusing to reset it.");
    }
  }
  return { ...relay, head };
}

function attach(db, device, relay) {
  compatible(device, relay);
  if (device.role === "unbound") {
    markTransport(db, "device", relay.stream);
    db.query("INSERT INTO sync_cursor VALUES (1, ?, 0)").run(relay.stream);
  }
}

// The log is complete on every v2 store, including devices. Check that the
// captured history can be paged dependency-first before publishing a clone.
function validateSnapshot(db) {
  const integrity = db.query("PRAGMA integrity_check").values();
  if (integrity.length !== 1 || integrity[0][0] !== "ok" || db.query("PRAGMA foreign_key_check").get()) {
    throw new Error("SQLite snapshot failed integrity or foreign-key validation.");
  }
  const sync = new SyncPrototype(db);
  const seen = new Map();
  let position = 0;
  for (const { sequence, id, payload } of db.query(`SELECT sequence, id, payload FROM sync_log
    JOIN sync_operations USING (id) JOIN sync_versions USING (id) ORDER BY sequence`).iterate()) {
    const op = sync.normalize(JSON.parse(payload));
    if (sequence !== ++position || op.id !== id || payload !== JSON.stringify(op) ||
        op.base.some((parent) => seen.get(parent) !== op.document)) throw new Error("Invalid snapshot sync log or dependencies.");
    seen.set(id, op.document);
  }
  if (db.query("SELECT count(*) AS n FROM sync_operations").get().n !== position ||
      db.query("SELECT 1 FROM sync_seed LEFT JOIN sync_views USING (id) WHERE sync_views.id IS NULL LIMIT 1").get()) {
    throw new Error("Snapshot sync history or projections are incomplete.");
  }
  for (const { raw, revision, deleted } of db.query("SELECT raw, revision, deleted FROM sync_views").iterate()) {
    if (digest(raw) !== revision || ![0, 1].includes(deleted)) throw new Error("Invalid snapshot sync projection.");
  }
  // Preserve the log's next sequence even when it is currently empty.
  if ((db.query("SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'").get()?.seq ?? 0) !== position) {
    throw new Error("Invalid snapshot sequence counter.");
  }
  return position;
}

function snapshot(source, scope, role) {
  const bytes = Buffer.from(access(source, false, (db) => {
    const from = state(db, scope);
    if (role === "relay" ? from.role !== "unbound" : from.role !== "relay") {
      throw new Error(role === "relay" ? "Relay initialization requires an unbound upgraded device."
        : "Device bootstrap requires an explicitly marked relay.");
    }
    return db.serialize(); // The read transaction pins one snapshot, including committed WAL pages.
  }));
  // sqlite3_deserialize cannot open a WAL-mode image. All committed pages are
  // already in the serialized image, so make the standalone copy rollback-mode.
  bytes[18] = bytes[19] = 1;
  const copy = Database.deserialize(bytes);
  try {
    copy.exec("PRAGMA foreign_keys = ON");
    const head = validateSnapshot(copy);
    copy.transaction(() => {
      if (role === "relay") {
        markTransport(copy, "relay", randomUUID());
        copy.exec("DELETE FROM sync_outbox"); // All pending v2 operations are already in the validated log.
      } else {
        copy.exec("UPDATE sync_transport SET role = 'device'");
        copy.query("INSERT INTO sync_cursor VALUES (1, ?, 0)").run(transportMarker(copy).stream);
      }
    }).immediate();
    const { space, genesis, stream } = state(copy, scope);
    return { data: copy.serialize(), space, genesis, stream, head };
  } finally { copy.close(); }
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publish(destination, scope, data) {
  const { root, directory, filename } = destination;
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  await location(root, scope, true);
  await syncDirectory(root);
  const staging = path.join(directory, `.snapshot-${randomUUID()}.tmp`);
  const handle = await open(staging, "wx", 0o600);
  try {
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await location(root, scope, true);
    // A same-directory hard link publishes the finished image atomically and
    // fails if another initializer already claimed the final database path.
    await link(staging, filename);
  } finally { await unlink(staging); }
  await syncDirectory(directory);
}

export async function bootstrapLocal({ root, relayRoot, scope, initializeRelay = false, dryRun = false }) {
  const role = initializeRelay ? "relay" : "device";
  const { device, relay } = await endpoints(root, relayRoot, scope, role);
  const destination = initializeRelay ? relay : device;
  const { data, stream, ...info } = snapshot(initializeRelay ? device : relay, scope, role);
  if (!dryRun) await publish(destination, scope, data);
  return { scope, role, dryRun, ...info, ...(initializeRelay && dryRun ? {} : { stream }), databasePath: destination.filename };
}

// Each access owns just one connection and transaction. No device lock is
// held while accessing the relay, or vice versa.
export async function transferLocal({ root, relayRoot, scope, push, limit }) {
  const { device, relay } = await endpoints(root, relayRoot, scope);
  const before = access(device, false, (db) => state(db, scope));
  const remote = access(relay, false, (db) => {
    const info = verifyRelay(db, scope, before);
    return push ? info : { ...info, page: new SyncPrototype(db).pull(info.stream, before.position ?? 0, limit) };
  });
  const identity = { scope, space: remote.space, genesis: remote.genesis, stream: remote.stream };
  if (!push) {
    const position = access(device, true, (db) => {
      attach(db, state(db, scope), remote);
      if (remote.page.entries.length) new SyncPrototype(db).receive(remote.page);
      return db.query("SELECT position FROM sync_cursor").get().position;
    });
    return { ...identity, pulled: remote.page.entries.length, position, head: remote.head, more: position < remote.head };
  }
  // Pin the stream even on the first push, before storing anything in the relay.
  const batch = access(device, true, (db) => {
    const local = state(db, scope);
    attach(db, local, remote);
    const rows = db.query(`SELECT payload FROM sync_log JOIN sync_outbox USING (id)
      JOIN sync_operations USING (id) ORDER BY sequence LIMIT ?`).all(limit);
    return { local: { ...local, stream: remote.stream }, operations: rows.map(({ payload }) => JSON.parse(payload)) };
  });
  if (batch.operations.length) {
    const receipts = access(relay, true, (db) => {
      verifyRelay(db, scope, batch.local);
      return new SyncPrototype(db).push(batch.operations);
    });
    // The relay transaction has committed durably before any device ack.
    const pending = access(device, true, (db) => {
      compatible(state(db, scope), remote);
      if (receipts.length !== batch.operations.length || receipts.some((receipt, i) =>
        receipt.id !== batch.operations[i].id || receipt.digest !== digest(JSON.stringify(batch.operations[i])))) {
        throw new Error("Invalid relay receipts; retaining device outbox.");
      }
      new SyncPrototype(db).acknowledge(receipts);
      return pendingCount(db);
    });
    return { ...identity, pushed: receipts.length, pending, more: pending > 0 };
  }
  const pending = access(device, false, pendingCount);
  return { ...identity, pushed: 0, pending, more: pending > 0 };
}
