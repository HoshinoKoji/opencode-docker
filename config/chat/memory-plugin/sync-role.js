// Additive operator metadata for v2. Earlier v2 stores have no marker and
// remain writable devices until explicitly attached to a relay.
export function transportMarker(db) {
  if (!db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sync_transport'").get()) return null;
  const rows = db.query("SELECT * FROM sync_transport").all();
  const marker = rows[0];
  if (rows.length !== 1 || marker.singleton !== 1 || !["device", "relay"].includes(marker.role) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(marker.stream)) {
    throw new Error("Invalid local sync role or stream marker.");
  }
  return { role: marker.role, stream: marker.stream };
}

export function markTransport(db, role, stream) {
  db.exec(`CREATE TABLE sync_transport (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    role TEXT NOT NULL CHECK(role IN ('device', 'relay')),
    stream TEXT NOT NULL
  )`);
  db.query("INSERT INTO sync_transport VALUES (1, ?, ?)").run(role, stream);
}
