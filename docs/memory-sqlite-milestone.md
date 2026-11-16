# SQLite memory: local milestone

## Verified sources (2026-11-16)

- [Bun SQLite](https://bun.com/docs/runtime/sqlite): built-in synchronous API,
  prepared statements, readonly connections, WAL and explicit transactions.
  `db.transaction` callbacks must be synchronous: async callbacks commit at the
  first await. This adapter therefore uses a dedicated connection with explicit
  BEGIN IMMEDIATE / COMMIT / ROLLBACK around inherited asynchronous operations.
- [D1 database / batch](https://developers.cloudflare.com/d1/worker-api/d1-database/):
  batch statements execute sequentially; a failed statement rolls back the
  batch. This does **not** establish application-level compare-and-swap correctness;
  conditional writes and competing pushes still require milestone-two tests.
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): Free database
  maximum 500 MB, Paid 10 GB; row/string/BLOB maximum 2,000,000 bytes; 100 bound
  parameters and 100 KB SQL per statement; 30-second query/batch duration.
  The fetched page says a batch counts as one query against the per-invocation
  limit (50 Free / 1000 Paid); individual statement limits still apply.
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): Free
  includes 5 million rows read/day, 100,000 rows written/day and 5 GB total.
  Paid includes 25 billion rows read/month, 50 million written/month and 5 GB;
  excess rates are $0.001/million reads, $1/million writes and $0.75/GB-month.
  Worker execution is billed separately. These are retrieved reference values,
  not a deployment cost estimate; recheck before deployment.
- [W3C Web Crypto AES-GCM](https://w3c.github.io/webcrypto/#aes-gcm) and
  [MDN encrypt](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt):
  AES-GCM provides authenticated encryption and supports additional authenticated
  data; Web Crypto provides key generation and encryption/decryption APIs.
  Future transport design uses AES-256-GCM, fresh 96-bit IVs per encryption and
  authenticated routing/version context. Local storage and sync execution remain
  trusted plaintext; encryption/decryption belongs at upload/download boundaries.

## Implemented architecture

`backend.js` exclusively constructs SQLite and rejects Markdown selection. `SQLiteMemoryStore` inherits
document validation, scope policy, metadata serialization, IDs, exact search,
pagination, recall, section replacement and full-document SHA-256 revisions from
`MemoryStore`. It overrides persistence primitives rather than copying the store.
MCP applies its existing external scope/read-only policy to SQLite.

SQLite requires an explicit absolute memory root. The root contains
`.memory-db/shared.sqlite` and, only when explicitly initialized or privately written,
`.memory-db/private.sqlite`. Reads use readonly connections and do not initialize
missing databases. No worktree or Markdown discovery/migration occurs. Scope
authorization runs before opening a database. A stored scope label rejects a
database accidentally placed at the other space's filename.

Schema version 1 (`PRAGMA user_version`) stores:

- `documents`: logical name, unique stable document ID, original serialized
  Markdown/YAML text, revision and current operation ID.
- `versions`: immutable-by-adapter whole-document snapshots with operation UUID,
  document ID, parent operation, revision and timestamp.
- `outbox`: pending operation IDs referencing versions, committed in the same
  transaction as the document. Identical record retries create no new version.
- `store_info`: local shared/private label.

WAL, FULL synchronous commits, a 100 ms SQLite busy timeout and bounded five-second
yielding BEGIN retries support competing writers without blocking another
in-process writer indefinitely. A separate connection and AsyncLocalStorage bind
every asynchronous mutation to its space transaction. Exceptions roll back all
document/version/outbox changes. Connections close after use. Database files use
0600 and newly created database directories use 0700; the root is caller-managed.
INDEX is generated from documents on demand. Returned record `path` remains the
legacy logical compatibility path; it is not a physical Markdown file in SQLite.

## Deliberate stopping point

This is local storage groundwork, not a sync implementation or a frozen network
protocol. Whole-document versions preserve today's API but do not solve stable
section identity, subtree changes or cross-device merge. Stable sections,
inbox/cursors/conflicts/tombstones, remote idempotency, transport encryption,
Worker/D1 deployment and database backup tooling remain future work. Explicit
`memory.sh init`, `import` (alias `migrate`) and `export` support absolute roots,
selected spaces and dry-run. See the README for full commands. Import preserves
raw UTF-8 bytes, existing IDs and metadata, leaves sources untouched, rejects
conflicting paths/IDs/destination content and commits transactionally per space.
All selected spaces preflight first; cross-space atomicity is not provided.
Exact retries are no-ops. Export preserves current documents, not version history.
Legacy plain Markdown stays byte-identical; missing metadata remains absent in
public reads and session indexes use deterministic legacy metadata. Ordinary
writes may initialize empty spaces for ergonomics; reads never initialize and
neither path imports Markdown automatically. Administrative commands are not
exposed as agent or MCP tools. No real memory migration has been performed.

Search uses the original case-insensitive all-term scan, including Chinese and
short terms. FTS acceleration is deferred. Version history is retained without
pruning; snapshot storage grows with edits. Read operations retain the existing
per-document read semantics rather than promising a multi-document snapshot.

Synthetic tests cover both public contracts, exact snapshot equivalence, retries,
revision races, transaction rollback, busy-writer recovery, persistence, explicit
root reuse across worktrees, plugin/CLI/MCP entrypoints, scope isolation and
read-only policy. Real memory and credentials are outside these tests.
