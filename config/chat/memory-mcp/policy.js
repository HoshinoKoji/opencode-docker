import { MemoryStore } from "../memory-plugin/store.js";
import { createMemoryStore } from "../memory-plugin/backend.js";

// External clients have no OpenCode execution-context identity. This adapter
// replaces only scope authorization on the selected store; document operations
// remain inherited from MemoryStore. No database is opened by construction.
export class ExternalMemoryStore extends MemoryStore {
  constructor(root, { space = "shared", readOnly = false, backend = "sqlite" } = {}) {
    super(root);
    if (!["shared", "private", "both"].includes(space)) throw new Error("Invalid configured space.");
    this.policy = Object.freeze({ space, readOnly });
    const store = createMemoryStore(root, { backend });
    store.policy = this.policy;
    store.scopes = this.scopes.bind(store);
    return store;
  }

  scopes(_identity, scope = "default", writing = false) {
    const { space, readOnly } = this.policy;
    if (writing && readOnly) throw new Error("Memory server is read-only.");
    if (scope === "default") {
      if (writing && space === "both") throw new Error("Select shared or private explicitly for writes.");
      scope = space;
    }
    if (!["shared", "private", "both"].includes(scope)) throw new Error("Invalid memory scope.");
    if (writing && scope === "both") throw new Error("Write to one memory space at a time.");
    if (space !== "both" && scope !== space) throw new Error(`Memory server permits ${space} scope only.`);
    return scope === "both" ? ["shared", "private"] : [scope];
  }
}
