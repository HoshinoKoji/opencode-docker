import { SQLiteMemoryStore } from "./sqlite.js";
import path from "node:path";

export function createMemoryStore(root, { backend = "sqlite" } = {}) {
  if (backend !== "sqlite") throw new Error("Only the sqlite memory backend is supported; use the explicit import command for Markdown.");
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("SQLite memory requires an explicit absolute root, independent of the worktree.");
  }
  return new SQLiteMemoryStore(root);
}
