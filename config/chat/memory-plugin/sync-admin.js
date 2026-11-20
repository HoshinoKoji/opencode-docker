import { randomUUID } from "node:crypto";
import { SESSION_FILENAME } from "./format.js";
import { SyncPrototype } from "./sync-prototype.js";

export const conflictName = (name) => typeof name === "string" && (name === "MEMORY.md" || SESSION_FILENAME.test(name));

// Local CLI administration only. The caller selects one authorized space.
export async function documentConflicts(store, scope, name, resolution) {
  if (scope !== "shared" && scope !== "private") throw new Error("Conflict administration requires one explicit space.");
  if (!conflictName(name)) throw new Error("Use MEMORY.md or an exact session record filename without directories; INDEX.md is derived.");
  const db = await store.open(scope, resolution !== undefined, { requireSync: true });
  try {
    const seed = db.query("SELECT id FROM sync_seed WHERE name = ?").get(name);
    if (!seed) throw new Error(`Memory document not found: ${name}.`);
    const sync = new SyncPrototype(db);
    const identity = { scope, name, logicalPath: store.relative(scope, name), id: seed.id };
    return { ...identity, ...(resolution === undefined ? sync.inspect(seed.id)
      : sync.resolve({ ...resolution, id: randomUUID(), document: seed.id })) };
  } finally { db.close(); }
}
