# Local memory sync engine and runtime integration

Status: implemented and tested on synthetic SQLite databases. Runtime supports
schema v1 and explicitly upgraded v2. The user reports their earlier real-data migration to SQLite is
complete; this milestone did not open real memory or credentials. No deployment,
commit or push was performed.

## Entry points and isolation

`config/chat/memory-plugin/sync-prototype.js` retains its original filename and exports:

- `migratePrototypeV2(db, { spaceId, synthetic: true })` upgrades an isolated v1
  connection transactionally for synthetic fixtures. `migrateSyncV2` is the shared
  migration implementation used by the backed-up administrative upgrade.
- `SyncPrototype(db)` exposes `prepare`, `commit`, `pending`, `push`,
  `acknowledge`, `pull`, `receive`, `view` and `operations`. The same class serves
  as a device and as the local SQLite relay in the simulator.

`SQLiteMemoryStore` now uses the engine for v2 ordinary writes. Both versions
support plugin, CLI and MCP. New databases still initialize as v1. No runtime open
or ordinary write upgrades a database. `synthetic: true` remains a fixture assertion,
not a sandbox. Operators use only the explicit `upgrade-sync` command below.

The simulator accepts caller-owned database connections rather than discovering
roots or worktrees. Its executable usage examples are the fixtures in
`tests/memory-sync.test.js`. Runtime absolute-root requirements, public IDs,
raw serialization, metadata, whole-file SHA-256 revisions, section-title reads,
permissions and consent boundaries continue through the shared runtime adapter.
The prototype has no agent authorization surface; it must not be exposed directly
as an agent/MCP tool.

## Explicit v1 → v2 upgrade and rollback

Install this code for every writer, then stop all plugin/CLI/MCP writers, including
already-loaded old code. From the checkout with Bun installed:

```sh
./memory.sh sync-status --root /absolute/database-root --space shared
./memory.sh upgrade-sync --root /absolute/database-root --space shared --dry-run
./memory.sh upgrade-sync --root /absolute/database-root --space shared
```

Use `private` only when authorized. Administration selects one space per command;
there is no cross-space transaction. Initialize an absent database with `init`
before upgrading. Dry-run opens the source read-only and validates migration on
an in-memory serialized copy. It creates no backup and changes no schema/data.
An actual upgrade takes `BEGIN IMMEDIATE`, writes an exclusive mode-0600 standalone
SQLite snapshot (including committed WAL pages), fsyncs the backup and directory,
and migrates within the lock. The JSON result returns physical `databasePath` and
`backupPath`; keep that backup. Failure rolls back schema/data, retaining any backup
already written. Repeating a successful upgrade is a no-op. Resume updated writers.

Older runtime code rejects schema v2. A connection opened before migration can
still write old tables, so **stop all writers before upgrade**. To roll back,
stop writers again, preserve the entire current v2 database directory separately,
and restore the returned standalone v1 backup as the selected space's SQLite file
in a **new empty root**. Point the old runtime explicitly at that root. Do not mix
old WAL/SHM files with a restored database. This restores pre-upgrade state; later
v2 edits remain in the preserved v2 database. Markdown export provides current
visible documents for a separate fresh import, with no operation/conflict history.
There is no automated downgrade or general backup/restore CLI.

Migration checks retained version hashes/parent identities, foreign keys, current document heads, raw hashes and metadata IDs, decodes
frontmatter, and runs schema creation and seed population in one immediate
transaction. A failure rolls back DDL and `user_version`. Repeating migration
with the same space is a no-op; other spaces and unknown versions fail closed.

At upgrade, all v1 `documents`, `versions`, `outbox` and `store_info` rows remain
byte-for-byte unchanged. Historical whole-document snapshots are retained. New tables are:

| Tables | Purpose |
| --- | --- |
| `sync_info`, `sync_seed` | Space ID, shared genesis fingerprint and immutable starting documents |
| `sync_operations`, `sync_versions` | Canonical operation payloads and immutable per-operation branch snapshots |
| `sync_views`, `sync_sections` | Materialized raw documents, revision/tombstone, stable section IDs and direct text |
| `sync_conflicts` | Concurrent overlapping operation pairs |
| `sync_outbox`, `sync_log` | Pending local operations and append-only relay sequence |
| `sync_cursor`, `sync_inbox` | One relay stream's durable cursor and sequence-to-operation bindings |

The v1 outbox is preserved as historical local state. Its operations are
**not** silently interpreted as section-aware sync operations. Replicas start
from identical v1 seed snapshots (including document heads). A genesis hash binds
every new operation to that seed; independently imported databases require future
bootstrap/reconciliation tooling. Existing historical versions are not replayed
to the relay. Runtime reads/search/recall/index and export use `sync_views` joined
to logical names in `sync_seed`, excluding tombstones. They see engine-received edits
and newly created records. Local runtime writes also append legacy `versions` and
refresh `documents`, using the same operation ID as the sync operation, in the same
transaction. These legacy tables are compatibility history, not the v2 read source;
received operations retain their authoritative snapshots in `sync_versions`.
The old `outbox` is frozen historical state; new pending operations use `sync_outbox`.

## Ordinary runtime writes and result naming

Public inputs and policy boundaries are unchanged: authorization precedes opening
spaces; the absolute root is independent of worktree/cwd. `record` returns
`logicalPath` instead of `path`; `name` keeps its `.md` suffix and the stored body
remains Markdown. Administrative paths and legacy physical backup-manifest fields
keep their physical meaning. Update metadata/IDs and whole-raw SHA-256 revisions
are preserved, including exact-section replacement and stale-revision rejection.

New documents produce `create` operations with a validated logical `name`, stable
document ID and empty causal base. Empty seeds derive from that ID; the operation
carries the initial raw document and replicates creation. Name/identity collisions
fail atomically. Retries reuse the saved record without appending operations.
Local modifications currently compile to **full-document** operations, even for
public section updates, to preserve frontmatter timestamps and custom metadata
atomically. Thus runtime edits to disjoint sections on separate devices can conflict;
only explicit engine section operations currently get disjoint-subtree merging.
This conservative boundary is deliberate until metadata-aware section operations
are designed. Conflicts and tombstones block ordinary updates/record replacement.
`sync-status` reports pending count, conflict operation IDs, tombstones and cursor.
It is read-only CLI administration, not an agent/MCP sync tool.

## Stable sections and conservative merge

The existing ATX/fenced-code parser builds a hierarchy from the decoded body.
Initial section IDs derive from the seed head and heading position. IDs, parent,
position, title, level and direct text persist in SQLite. Direct text ends at the
next heading; subtree replacement includes descendants. Frontmatter and body
preamble remain in the authoritative raw snapshot.

Section operations address IDs, replace an entire subtree and retain IDs only
when the ordered heading titles/levels remain identical. Boundary swallowing,
added/removed/renamed headings and unclosed fences that change the outline fail.
Structural edits require explicit full-document operations, which start a new
identity epoch for every heading when the outline changes. Full operations with
the same ordered titles/levels retain positional section identities. The engine does not guess identity matches
through renames or moves. Identical-looking duplicate headings remain positional
within a subtree; callers must express moves as full replacements.

Each operation contains a globally unique caller-supplied ID, space/genesis,
document ID, sorted causal closure (`base`), kind (`section`, `full`, `delete`, `create`),
target and content. Persist/retry the exact prepared object. Re-preparing after
observing more operations changes the causal base and is a different operation.

Materialization validates each operation against its own causal base and saves
that branch's complete raw snapshot. Concurrent disjoint subtrees commute.
Same-section, ancestor/descendant, full-document and structural operations
overlap conservatively. Both overlapping operations and their descendants are
excluded from the visible projection, with all operations and branch snapshots
retained. Unaffected concurrent edits remain visible. Thus learning a late
conflict can return the visible affected text to its common base rather than
choosing a winner. Conflicts freeze further local edits to that document until
explicit resolution is implemented; this prototype does not claim resolution UI.

Document deletion is an enduring tombstone. A concurrent edit is preserved as a
conflict branch, and the visible document remains deleted. `view()` returns the
`deleted` flag alongside retained raw text for diagnostics; consumers must honor
that flag. Edits causally after deletion fail. Restore, section deletion as a
separate operation, pruning and garbage collection are deferred. Section removal
can currently be expressed only by a full-document structural rewrite.

## Retry and transaction protocol

- Canonical payloads normalize object key order. The same operation ID/content
  is a no-op; the same ID with different routing, base or content is rejected.
- Local mutation commits operation, branch snapshot, projection and outbox
  together. Relay push commits a validated batch and monotonic log atomically.
  Reversed dependency order within a batch is supported; log assignment is
  dependency-first so paginated pulls can be applied one item at a time.
- Push receipts bind operation ID and payload hash. Losing a receipt leaves the
  local outbox intact; resend returns the same receipt. Explicit acknowledgement
  is transactional. Receiving one's own operation also clears its outbox row.
- Receive commits validated operations, snapshots, conflicts, projection, inbox,
  outbox acknowledgement and cursor in one transaction. There is no separate
  partially applied inbox state. This is trusted plaintext local application.
- Duplicate and overlapping pages validate against the retained sequence map;
  cursors never regress. Gaps, stream changes, rewritten sequence IDs and one
  operation assigned multiple sequence numbers fail. Missing dependencies reject
  the entire page without advancement; retry with the earlier page/batch.
- Batches/pages are limited to 100, causal lists to 10,000, and raw text to
  1,000,000 JavaScript string units. These are simulator bounds, not a finalized
  HTTP byte-budget or production scaling policy. SQLite busy errors leave state
  unchanged; caller retries after contention. No automatic network loop exists.

## Verification and next integration boundary

The focused suites cover additive migration and rollback, dual-schema runtime
support, persisted IDs/reopen, independent/same/parent-child/full/structural
edits, late-conflict descendants, tombstones/old clients, lost replies and
duplicates, malformed batches/causal closure, paginated restart, stream rewriting,
injected transaction failures, actual subprocess exit during receive, and writer
contention/retry. Runtime integration adds plugin execution across worktrees,
real CLI and MCP stdio v1/v2 record/read/update, logicalPath contracts, read-only
rejection, metadata/revision preservation, backed-up upgrade and dry-run, malformed
history/operations, create replication, projection export and local-write rollback.
The publish image's synthetic Bun check includes the sync suite.
Verification after integration: **88 Bun tests passed** across plugin, CLI,
SQLite, transfer, sync and MCP suites; **90 Python tests passed**; `git diff --check`
passed. All data fixtures were synthetic.

Next work is metadata-aware section operations, explicit conflict resolution and
restoration, and operator bootstrap/local sync commands. Bootstrap currently has
only synthetic tests: clone one coherent upgraded snapshot into new roots before
editing, retaining the same space/genesis; do not independently upgrade replicas
and assume they belong to one stream. There is no user-facing bootstrap or sync
command. Do not manually edit operation payloads, outboxes or conflict tables. The
current rebuild algorithm recomputes the retained DAG and is intended for small
synthetic histories. Incremental indexing and scale testing are still required.

Worker/D1 conditional-write races, HTTP transport, authentication/revocation,
encryption, key recovery, deployment, general backup/restore tooling, stream reset and
multi-relay support remain deferred. The previously verified official references
are in [the SQLite milestone](memory-sqlite-milestone.md#verified-sources-2026-11-16).
Local SQLite and sync execution stay trusted plaintext; optional cryptography
belongs at the future upload/download boundary. Cloudflare semantics and current
limits must be rechecked before implementing that boundary.
