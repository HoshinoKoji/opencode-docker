// Local sync engine. Runtime activation requires an explicit administrative upgrade.
// The caller owns the connection and the authorization boundary.
import { digest, decode, encode } from "./format.js";
import { sections } from "./sections.js";

const fail = (message) => { throw new Error(message); };
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const MAX_RAW = 1_000_000;
const canonicalTimestamp = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

// Offsets include frontmatter, while headings are parsed only from the body.
// Direct text stops at the next heading; subtree end includes descendants.
function outline(raw, seed, ids) {
  const { body } = decode(raw);
  const prefix = raw.length - body.length;
  const headings = sections(body);
  const stack = [];
  return headings.map((heading, index) => {
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    const node = { ...heading, id: ids?.[index] ?? digest(`${seed}:${index}`),
      parent: stack.at(-1)?.id ?? null, position: index,
      start: prefix + heading.start, end: prefix + heading.end,
      directEnd: prefix + (headings[index + 1]?.start ?? body.length) };
    stack.push(node);
    return node;
  });
}
const shape = (nodes) => nodes.map(({ title, level }) => [title, level]);

function apply(state, op) {
  if (state.deleted) fail("Deleted document requires explicit restoration (not implemented).");
  if (op.kind === "delete") return { ...state, deleted: true };
  if (op.kind === "full" || op.kind === "create") {
    const metadata = decode(op.content).metadata;
    if (metadata && metadata.id !== op.document) fail("Document metadata identity changed.");
    const nodes = outline(op.content, op.id);
    return { raw: op.content, nodes: same(shape(nodes), shape(state.nodes))
      ? outline(op.content, op.id, state.nodes.map((node) => node.id)) : nodes, deleted: false };
  }
  const target = state.nodes.find((node) => node.id === op.target);
  if (!target) fail("Unknown section identity.");
  const boundary = sections(`${op.content}${"#".repeat(target.level)} boundary\n`);
  if (!boundary.some((node) => node.start === op.content.length)) fail("Structural section edit requires a closed, newline-terminated subtree.");
  const raw = state.raw.slice(0, target.start) + op.content + state.raw.slice(target.end);
  const nodes = outline(raw, op.id, state.nodes.map((node) => node.id));
  // Reject structural changes, unclosed fences and boundary swallowing. Callers
  // must deliberately use a full-document operation for any structural rewrite.
  if (!same(shape(nodes), shape(state.nodes)) ||
      nodes.find((node) => node.id === target.id)?.start !== target.start ||
      nodes.find((node) => node.id === target.id)?.end !== target.start + op.content.length) {
    fail("Structural section edit requires a full-document operation.");
  }
  if (op.updatedAt !== undefined) {
    const { metadata, body } = decode(raw);
    if (!metadata || metadata.id !== op.document) fail("Timestamped section updates require matching document metadata.");
    // Commutative across disjoint edits, regardless of clock skew or replay order.
    const updated_at = Date.parse(op.updatedAt) > Date.parse(metadata.updated_at) ? op.updatedAt : metadata.updated_at;
    const stamped = encode({ ...metadata, updated_at }, body);
    return { raw: stamped, nodes: outline(stamped, op.id, nodes.map((node) => node.id)), deleted: false };
  }
  return { raw, nodes, deleted: false };
}

function overlaps(a, b, states) {
  if (a.kind !== "section" || b.kind !== "section") return true;
  if (a.target === b.target) return true;
  for (const state of [states.get(a.id), states.get(b.id)]) {
    const x = state.nodes.find((node) => node.id === a.target);
    const y = state.nodes.find((node) => node.id === b.target);
    if (x && y && (x.start <= y.start && x.end >= y.end || y.start <= x.start && y.end >= x.end)) return true;
  }
  return false;
}

function materialize(seed, ops, states) {
  const conflicts = [];
  const blocked = new Set();
  for (let i = 0; i < ops.length; i++) for (let j = i + 1; j < ops.length; j++) {
    const a = ops[i], b = ops[j];
    if (!a.base.includes(b.id) && !b.base.includes(a.id) && overlaps(a, b, states)) {
      conflicts.push([a.id, b.id].sort());
      blocked.add(a.id); blocked.add(b.id);
    }
  }
  // ops are topologically sorted. Descendants of a newly discovered conflict
  // retain their branch snapshots but cannot silently resolve that conflict.
  for (const op of ops) if (op.base.some((id) => blocked.has(id))) blocked.add(op.id);
  let state = { raw: seed.raw, nodes: outline(seed.raw, seed.head), deleted: false };
  for (const op of ops) if (!blocked.has(op.id)) state = apply(state, op);
  // Delete/edit conflicts are hidden behind a tombstone until explicit resolution.
  if (ops.some((op) => op.kind === "delete")) state.deleted = true;
  return { ...state, conflicts, blocked };
}

export function migratePrototypeV2(db, { spaceId, synthetic = false } = {}) {
  if (!synthetic || !identifier(spaceId)) fail("Explicit synthetic copy and spaceId required.");
  return migrateSyncV2(db, { spaceId });
}

// Administrative callers must take a consistent backup before invoking this.
export function migrateSyncV2(db, { spaceId } = {}) {
  if (!identifier(spaceId)) fail("Valid spaceId required.");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 100;");
  db.transaction(() => {
    const version = db.query("PRAGMA user_version").get().user_version;
    if (version === 2) {
      if (db.query("SELECT space FROM sync_info").get()?.space !== spaceId) fail("Space mismatch.");
      return;
    }
    if (version !== 1) fail(`Expected v1 copy, got schema ${version}.`);
    const history = db.query("SELECT * FROM versions").all();
    const versions = new Map(history.map((row) => [row.operation_id, row]));
    for (const row of history) {
      if (digest(row.raw) !== row.revision || row.parent && versions.get(row.parent)?.document_id !== row.document_id) fail("Invalid v1 version history.");
    }
    if (db.query("PRAGMA foreign_key_check").all().length) fail("Invalid v1 foreign keys.");
    const docs = db.query("SELECT * FROM documents ORDER BY id").all();
    for (const doc of docs) {
      const head = db.query("SELECT * FROM versions WHERE operation_id = ?").get(doc.head);
      if (!head || head.document_id !== doc.id || head.raw !== doc.raw ||
          head.revision !== doc.revision || digest(doc.raw) !== doc.revision) fail("Invalid v1 document head.");
      if (doc.raw.length > MAX_RAW) fail("Prototype document too large.");
      const metadata = decode(doc.raw).metadata;
      if (metadata && metadata.id !== doc.id) fail("Invalid v1 metadata identity.");
    }
    db.exec(`
      CREATE TABLE sync_info (space TEXT NOT NULL, genesis TEXT NOT NULL);
      CREATE TABLE sync_seed (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw TEXT NOT NULL, head TEXT NOT NULL);
      CREATE TABLE sync_operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE sync_versions (id TEXT PRIMARY KEY REFERENCES sync_operations(id), raw TEXT NOT NULL, deleted INTEGER NOT NULL);
      CREATE TABLE sync_views (id TEXT PRIMARY KEY, raw TEXT NOT NULL, revision TEXT NOT NULL, deleted INTEGER NOT NULL);
      CREATE TABLE sync_sections (document TEXT NOT NULL, id TEXT NOT NULL, parent TEXT, position INTEGER NOT NULL,
        title TEXT NOT NULL, level INTEGER NOT NULL, direct TEXT NOT NULL, PRIMARY KEY(document, id));
      CREATE TABLE sync_conflicts (document TEXT NOT NULL, left_id TEXT NOT NULL, right_id TEXT NOT NULL,
        PRIMARY KEY(document, left_id, right_id));
      CREATE TABLE sync_outbox (id TEXT PRIMARY KEY REFERENCES sync_operations(id));
      CREATE TABLE sync_log (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE REFERENCES sync_operations(id));
      CREATE TABLE sync_cursor (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), stream TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE sync_inbox (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE REFERENCES sync_operations(id));
    `);
    db.query("INSERT INTO sync_info VALUES (?, ?)").run(spaceId, digest(JSON.stringify(docs)));
    for (const doc of docs) {
      db.query("INSERT INTO sync_seed VALUES (?, ?, ?, ?)").run(doc.id, doc.name, doc.raw, doc.head);
      persist(db, doc.id, { raw: doc.raw, nodes: outline(doc.raw, doc.head), deleted: false, conflicts: [] });
    }
    db.exec("PRAGMA user_version = 2;");
  }).immediate();
}

function persist(db, id, state) {
  db.query("INSERT OR REPLACE INTO sync_views VALUES (?, ?, ?, ?)").run(id, state.raw, digest(state.raw), Number(state.deleted));
  db.query("DELETE FROM sync_sections WHERE document = ?").run(id);
  for (const node of state.nodes) db.query("INSERT INTO sync_sections VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, node.id, node.parent, node.position, node.title, node.level, state.raw.slice(node.start, node.directEnd));
  db.query("DELETE FROM sync_conflicts WHERE document = ?").run(id);
  for (const pair of state.conflicts) db.query("INSERT INTO sync_conflicts VALUES (?, ?, ?)").run(id, ...pair);
}

export class SyncPrototype {
  constructor(db) {
    if (db.query("PRAGMA user_version").get().user_version !== 2) fail("Explicit prototype migration required.");
    this.db = db;
    this.info = db.query("SELECT * FROM sync_info").get();
  }

  normalize(input) {
    const stamped = input?.kind === "section" && Object.hasOwn(input, "updatedAt");
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        !same(Object.keys(input).sort(), ["base", "content", "document", "genesis", "id", "kind", "space", "target", ...(input.kind === "create" ? ["name"] : []), ...(stamped ? ["updatedAt"] : [])].sort()) ||
        !identifier(input.id) || typeof input.document !== "string" ||
        input.space !== this.info.space || input.genesis !== this.info.genesis ||
        !Array.isArray(input.base) || input.base.length > 10000 || !input.base.every(identifier) ||
        !same(input.base, [...new Set(input.base)].sort()) || input.base.includes(input.id) ||
        !["section", "full", "delete", "create"].includes(input.kind) ||
        (input.kind === "create" && (input.base.length !== 0 || typeof input.name !== "string" ||
          !/^(MEMORY|\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.test(input.name))) ||
        (input.kind === "section" ? !identifier(input.target) : input.target !== null) ||
        (stamped && !canonicalTimestamp(input.updatedAt)) ||
        (input.kind === "delete" ? input.content !== null : typeof input.content !== "string" || input.content.length > MAX_RAW)) {
      fail("Malformed operation or space/genesis mismatch.");
    }
    // Canonical key order makes retries independent of JSON object key order.
    const { id, space, genesis, document, base, kind, target, content } = input;
    return { id, space, genesis, document, base, kind, target, content,
      ...(kind === "create" ? { name: input.name } : {}), ...(stamped ? { updatedAt: input.updatedAt } : {}) };
  }

  operations() { return this.db.query("SELECT payload FROM sync_operations").all().map((row) => JSON.parse(row.payload)); }
  pending() { return this.db.query("SELECT payload FROM sync_operations JOIN sync_outbox USING(id) ORDER BY id").all().map((row) => JSON.parse(row.payload)); }
  view(document) {
    return { ...this.db.query("SELECT * FROM sync_views WHERE id = ?").get(document),
      sections: this.db.query("SELECT * FROM sync_sections WHERE document = ? ORDER BY position").all(document),
      conflicts: this.db.query("SELECT * FROM sync_conflicts WHERE document = ? ORDER BY left_id, right_id").all(document) };
  }

  // Rebuild from immutable operations. This deliberately favors a small,
  // auditable simulator over incremental production-scale DAG indexing.
  #rebuild() {
    const pending = this.operations().sort((a, b) => compare(a.id, b.id));
    const ordered = [], known = new Map(), states = new Map();
    const seeds = new Map(this.db.query("SELECT * FROM sync_seed").all().map((row) => [row.id, row]));
    while (pending.length) {
      const index = pending.findIndex((op) => op.base.every((id) => known.has(id)));
      if (index < 0) fail("Missing dependencies or causal cycle; retry with earlier operations.");
      const [op] = pending.splice(index, 1);
      const seed = seeds.get(op.document);
      if (!seed) fail("Unknown document.");
      for (const id of op.base) {
        const parent = known.get(id);
        if (parent.document !== op.document || parent.base.some((ancestor) => !op.base.includes(ancestor))) fail("Invalid causal closure.");
      }
      const base = materialize(seed, ordered.filter((item) => op.base.includes(item.id)), states);
      if (base.conflicts.length) fail("Conflict resolution is not implemented.");
      states.set(op.id, base);
      const branch = apply(base, op);
      if (branch.raw.length > MAX_RAW) fail("Prototype document too large.");
      this.db.query("INSERT OR IGNORE INTO sync_versions VALUES (?, ?, ?)").run(op.id, branch.raw, Number(branch.deleted));
      known.set(op.id, op); ordered.push(op);
    }
    for (const [id, seed] of seeds) persist(this.db, id, materialize(seed, ordered.filter((op) => op.document === id), states));
  }

  #insert(operations, local = false) {
    if (!Array.isArray(operations) || operations.length > 100) fail("Invalid batch size.");
    const added = [];
    for (const input of operations) {
      const op = this.normalize(input), payload = JSON.stringify(op);
      const prior = this.db.query("SELECT payload FROM sync_operations WHERE id = ?").get(op.id);
      if (prior) {
        if (prior.payload !== payload) fail("Operation ID reused with different content.");
        continue;
      }
      this.db.query("INSERT INTO sync_operations VALUES (?, ?)").run(op.id, payload);
      if (op.kind === "create") {
        if (this.db.query("SELECT id FROM sync_seed WHERE id = ? OR name = ?").get(op.document, op.name)) fail("Document creation identity/name collision.");
        if (!identifier(op.document)) fail("Invalid document identity.");
        this.db.query("INSERT INTO sync_seed VALUES (?, ?, '', ?)").run(op.document, op.name, `create:${op.document}`);
      }
      added.push(op);
      if (local) this.db.query("INSERT INTO sync_outbox VALUES (?)").run(op.id);
    }
    this.#rebuild();
    // A reversed batch must still yield dependency-first paginated pulls.
    for (const op of added.sort((a, b) => a.base.length - b.base.length || compare(a.id, b.id))) {
      this.db.query("INSERT INTO sync_log(id) VALUES (?)").run(op.id);
    }
  }

  // Compiling is read-only. Persist and retry this exact object after a lost
  // response; recompiling against newer dependencies is a different operation.
  prepare({ id, document, kind = "section", target = null, content = null, name, updatedAt }) {
    return this.normalize({ id, space: this.info.space, genesis: this.info.genesis, document,
      base: this.operations().filter((op) => op.document === document).map((op) => op.id).sort(), kind, target, content,
      ...(kind === "create" ? { name } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) });
  }

  // Compile a public section edit only if it can be represented as a splice of
  // one existing subtree and an updated_at change. The caller holds a write lock.
  prepareSectionUpdate({ id, document, section, raw, view }) {
    const before = decode(view.raw), after = decode(raw);
    if (!before.metadata || !after.metadata || !canonicalTimestamp(after.metadata.updated_at) ||
        encode({ ...before.metadata, updated_at: after.metadata.updated_at }, after.body) !== raw) return null;
    const previous = outline(view.raw, id, view.sections.map((node) => node.id));
    const next = outline(raw, id);
    if (!same(shape(previous), shape(next))) return null;
    const targets = previous.filter((node) => node.title === section);
    if (targets.length !== 1) return null;
    const target = targets[0], replacement = next[target.position];
    const content = raw.slice(replacement.start, replacement.end);
    const left = view.raw.slice(view.raw.length - before.body.length, target.start);
    const right = view.raw.slice(target.end);
    if (left + content + right !== after.body) return null;
    if (!sections(`${content}${"#".repeat(target.level)} boundary\n`).some((node) => node.start === content.length)) return null;
    const op = this.prepare({ id, document, target: target.id, content, updatedAt: after.metadata.updated_at });
    return { op, raw: apply({ raw: view.raw, nodes: previous, deleted: false }, op).raw };
  }
  commit(op) { this.db.transaction(() => this.#insert([op], true)).immediate(); return op; }

  // Local relay adapter: push receipt can be lost safely. Atomic batches include
  // validation, history, deterministic materialization and monotonic log IDs.
  push(operations) {
    return this.db.transaction(() => {
      this.#insert(operations);
      return operations.map((op) => ({ id: op.id, digest: digest(JSON.stringify(this.normalize(op))) }));
    }).immediate();
  }
  acknowledge(receipts) {
    this.db.transaction(() => {
      if (!Array.isArray(receipts) || receipts.length > 100) fail("Invalid receipts.");
      for (const receipt of receipts) {
        const row = this.db.query("SELECT payload FROM sync_operations WHERE id = ?").get(receipt.id);
        if (!row || digest(row.payload) !== receipt.digest) fail("Receipt mismatch.");
        this.db.query("DELETE FROM sync_outbox WHERE id = ?").run(receipt.id);
      }
    }).immediate();
  }
  pull(stream, after = 0, limit = 100) {
    if (!identifier(stream) || !Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail("Invalid pull.");
    const rows = this.db.query("SELECT sequence, payload FROM sync_log JOIN sync_operations USING(id) WHERE sequence > ? ORDER BY sequence LIMIT ?").all(after, limit);
    return { stream, after, entries: rows.map(({ sequence, payload }) => ({ sequence, operation: JSON.parse(payload) })) };
  }
  receive(page) {
    this.db.transaction(() => {
      if (!page || !identifier(page.stream) || !Number.isSafeInteger(page.after) || page.after < 0 ||
          !Array.isArray(page.entries) || page.entries.length > 100) fail("Invalid page.");
      const cursor = this.db.query("SELECT * FROM sync_cursor").get();
      const position = cursor?.position ?? 0;
      if (cursor && cursor.stream !== page.stream || page.after > position) fail("Stream mismatch or cursor gap.");
      for (const [index, entry] of page.entries.entries()) {
        if (entry.sequence !== page.after + index + 1 || !Number.isSafeInteger(entry.sequence)) fail("Noncontiguous page.");
        const prior = this.db.query("SELECT id FROM sync_inbox WHERE sequence = ?").get(entry.sequence);
        if (prior ? prior.id !== entry.operation?.id : entry.sequence <= position) fail("Rewritten stream history.");
        const seen = this.db.query("SELECT sequence FROM sync_inbox WHERE id = ?").get(entry.operation?.id ?? "");
        if (seen && seen.sequence !== entry.sequence) fail("Operation repeated at a different stream sequence.");
      }
      this.#insert(page.entries.map((entry) => entry.operation));
      for (const entry of page.entries) {
        const seen = this.db.query("SELECT sequence FROM sync_inbox WHERE id = ?").get(entry.operation.id);
        if (seen && seen.sequence !== entry.sequence) fail("Operation repeated at a different stream sequence.");
        this.db.query("INSERT OR IGNORE INTO sync_inbox VALUES (?, ?)").run(entry.sequence, entry.operation.id);
        this.db.query("DELETE FROM sync_outbox WHERE id = ?").run(entry.operation.id);
      }
      this.db.query("INSERT OR REPLACE INTO sync_cursor VALUES (1, ?, ?)").run(page.stream, Math.max(position, page.after + page.entries.length));
    }).immediate();
  }
}
