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
- `SyncPrototype(db)` exposes `prepare`, `commit`, `inspect`, `resolve`, `pending`,
  `push`, `acknowledge`, `pull`, `receive`, `view` and `operations`. The same class serves
  as a device and as the local SQLite relay in the simulator.

`SQLiteMemoryStore` now uses the engine for v2 ordinary writes. Both versions
support plugin, CLI and MCP; public session deletion requires v2. New databases still initialize as v1. No runtime open
or ordinary write upgrades a database. `synthetic: true` remains a fixture assertion,
not a sandbox. Operators upgrade only through the explicit `upgrade-sync` command below.

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
| `sync_conflicts` | Active concurrent overlapping operation pairs |
| `sync_outbox`, `sync_log` | Pending local operations and append-only relay sequence |
| `sync_cursor`, `sync_inbox` | One relay stream's durable cursor and sequence-to-operation bindings |
| `sync_transport` | Optional operator-managed role and stable local stream ID; absent on ordinary unbound v2 stores |

The v1 outbox is preserved as historical local state. Its operations are
**not** silently interpreted as section-aware sync operations. Replicas start
from identical v1 seed snapshots (including document heads). A genesis hash binds
every new operation to that seed; independently upgraded databases are separate
spaces. Operator bootstrap clones the same genesis and retains historical v1
versions; these versions are not streamed as operations. Runtime reads/search/recall/index and export use `sync_views` joined
to logical names in `sync_seed`, excluding tombstones. They see engine-received edits
and newly created records. Local runtime creation and updates append legacy `versions` and
refresh `documents`, using the same operation ID as the sync operation, in the same
transaction. These legacy tables are compatibility history, not the v2 read source;
received operations and public deletions retain their authoritative snapshots in
`sync_versions`. Deletion leaves the compatibility tables intact.
The old `outbox` is frozen historical state; new pending operations use `sync_outbox`.

## Ordinary runtime writes and result naming

Authorization precedes opening
spaces; the absolute root is independent of worktree/cwd. `record` returns
`logicalPath` instead of `path`; `name` keeps its `.md` suffix and the stored body
remains Markdown. Administrative paths and legacy physical backup-manifest fields
keep their physical meaning. Update metadata/IDs and whole-raw SHA-256 revisions
are preserved, including exact-section replacement and stale-revision rejection.
`update` accepts an existing session filename or defaults to `MEMORY.md`.
Session edits preserve the stored summary; `updated_at` is refreshed.

New documents produce `create` operations with a validated logical `name`, stable
document ID and empty causal base. Empty seeds derive from that ID; the operation
carries the initial raw document and replicates creation. Name/identity collisions
fail atomically. Retries reuse the saved record without appending operations when
their payload still matches; a retry that differs after a body edit fails.
On v2, ordinary `update` calls with `section` compile to **section** operations
when the ordered heading outline is unchanged, the splice affects only the
selected subtree, and the document already has frontmatter. The payload targets
the stable section ID and includes the replacement subtree plus an ISO UTC
`updatedAt`. The engine preserves all other metadata and uses the maximum of
the current `updated_at` and the incoming timestamp. Disjoint edits therefore
merge without losing either body change or rolling the section timestamp back.
The returned revision hashes the actual written projection. Whole-body updates,
outline changes and first-time frontmatter insertion fall back to whole-document
operations. v1 behavior is unchanged. Conflicts and tombstones block ordinary writes. The public
`delete` operation accepts only an existing session record with its current full
revision. Its sync operation, branch snapshot, projection and outbox commit
together. The tombstoned name and ID remain reserved against local record
retries and imports. Markdown export contains only visible documents and does
not carry tombstones when imported into a fresh database.
`sync-status` reports role, stream (if bound), pending count, conflict operation
IDs, tombstones, cursor and relay head (on a relay).
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
document ID, sorted causal closure (`base`), kind (`section`, `full`, `delete`, `create`, `resolve`),
target and content. A section operation may additionally carry `updatedAt`;
existing payloads without it remain readable. No schema change is needed, but
reload all v2 writers and sync engines before generating or replaying timestamped
section or resolution operations: older v2 code cannot replay them. Persist/retry the exact prepared object. Re-preparing after
observing more operations changes the causal base and is a different operation.

Materialization validates each operation against its own causal base and saves
that branch's complete raw snapshot. Concurrent disjoint subtrees commute.
Same-section, ancestor/descendant, full-document and structural operations
overlap conservatively. Both overlapping operations and their descendants are
excluded from the visible projection, with all operations and branch snapshots
retained. Unaffected concurrent edits remain visible. Thus learning a late
conflict can return the visible affected text to its common base rather than
choosing a winner. Ordinary edits to a conflicted document remain blocked until
explicit operator resolution.

Document deletion is an enduring tombstone. A concurrent edit is preserved as a
conflict branch, and the visible document remains deleted. `view()` returns the
`deleted` flag alongside retained raw text for diagnostics; consumers must honor
that flag. Edits and resolutions causally after deletion fail. Even a late,
concurrent delete keeps the document hidden. Tombstone resolution/restoration,
section deletion as a separate operation, pruning and garbage collection are
deferred. Section removal requires a full-document structural rewrite.

## Local conflict inspection and resolution

```sh
./memory.sh conflicts 2026-01-01-topic.md --root /absolute/database-root --space shared
./memory.sh resolve --root /absolute/database-root --space shared --input resolution.json
```

Use `MEMORY.md` or an exact session filename, not a logical path or `INDEX.md`.
One authorized space per command (shared by default; `private` is opt-in).
Neither command initializes or upgrades a database. `conflicts` opens the
database read-only and returns a consistent snapshot: identity, visible `raw`
and `revision`, `deleted`, `conflictToken`, active operation ID pairs in
`conflicts`, and `branches` with raw snapshots of the pair endpoints and their
affected descendants. Inspect output includes plaintext history from the selected
document. A clean document has empty `conflicts` and `branches`.

Supply JSON via `--input FILE` or `--input -`:

```json
{
  "name": "2026-01-01-topic.md",
  "expectedRevision": "<revision from conflicts>",
  "conflictToken": "<conflictToken from conflicts>",
  "branchId": "<branches[].operationId from conflicts>"
}
```

Use `content` instead of `branchId` to submit a complete, non-empty merged
Markdown body without YAML. A manual merge resolves **all active pairs shown in
that inspection for that document**. Start from the visible `raw` body and review
each branch, including dependent edits, to retain the edits you want. Branch
selection is allowed only for a single pair with no affected descendants. When
both arms are section edits, selection grafts the chosen subtree onto the visible
baseline. Any visible operation outside the arms' common history must be disjoint
from that graft. Whole-document snapshot selection requires all visible operations
to be in the arms' common history. If selection is ambiguous or could lose an
independent edit, supply a manual merge instead.

Both modes preserve the visible frontmatter (including `updated_at`, or absence
of frontmatter on legacy documents) and document ID. Branches with different
metadata stay intact in history. Under a SQLite write lock, resolution compares
both the visible revision and a token hashing the exact document operation
payloads, active pairs, tombstone state and space/genesis identity. Re-inspect on
mismatch, even when the visible raw text has not changed. On success the CLI
returns the new `operationId` and projected `revision` with document identity.
For an uncertain CLI outcome, re-inspect; it does not issue a second resolution
using an old token. Relay retries replay the exact operation. `conflicts` may
show a tombstone and its branches, but `resolve` rejects it in both modes. These
are operator-only CLI commands; caller scope, consent and read-only restrictions apply.

A resolution is a conservative whole-document operation. Its complete `base`
references the inspected history; replay derives the exact active pairs from
that closure, rejects a clean or deleted base, and computes the resolved snapshot
from that same base. It is the only operation allowed to build on a conflicted
base. A resolved pair stays historical and keeps its original branches out of the
projection; the resolution and causal descendants can cross that pair. Concurrent
resolutions conflict with each other. A late edit or resolution concurrent with
the resolution creates new pairs, even if a section edit would previously have
been disjoint. These pairs and affected snapshots stay available for a new explicit
resolution; old resolutions never clear pairs absent from their causal view.
History is immutable; the resolution changes projection, not old snapshots.

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

## Operator local relay and device bootstrap

Use the updated CLI and runtime on all devices. The example paths are
placeholders; first upgrade the original device as described above. Create the
empty `/absolute/relay` and `/absolute/new-device` roots before running:

```sh
./memory.sh sync-relay-init --root /absolute/first-device --relay /absolute/relay --space shared --dry-run
./memory.sh sync-relay-init --root /absolute/first-device --relay /absolute/relay --space shared
./memory.sh sync-push --root /absolute/first-device --relay /absolute/relay --space shared
./memory.sh sync-bootstrap --root /absolute/new-device --relay /absolute/relay --space shared --dry-run
./memory.sh sync-bootstrap --root /absolute/new-device --relay /absolute/relay --space shared
./memory.sh sync-pull --root /absolute/new-device --relay /absolute/relay --space shared
```

Each invocation selects one authorized space by explicit `--space shared` or
`--space private`; `both` is unavailable. Both absolute roots must be real,
distinct existing directories. The selected destination `.memory-db/<space>.sqlite`
and sidecars (`-wal`, `-shm`, `-journal`) must be absent. Other spaces are left
alone. Use a trusted local filesystem that supports SQLite locking, hard links
and fsync; exclude concurrent destination writers during setup and do not use
network shares or file sync services. These are CLI operator actions, outside
agent/MCP tools and subject to caller scope and consent restrictions.

- **Relay setup:** `sync-relay-init` takes one consistent read snapshot of an
  unbound v2 first device via Bun SQLite serialization. The snapshot contains
  committed WAL pages, not uncommitted writes. It retains the space ID, genesis,
  v1 history, all v2 operations and sequences (including pending causal
  ancestors), branches, conflicts, projections and tombstones. The marked
  relay gets a random stable stream ID, no device cursor/inbox and no v2 outbox.
  Setup leaves the first device's pending work intact. Its first compatible
  push or pull binds it to the selected relay. Use only one relay for a space.
- **New device:** `sync-bootstrap` takes the same kind of snapshot from a
  marked relay. It records the relay's stream, an empty inbox/outbox and cursor
  0. The new device can read and edit immediately. Pulling replays known
  operations idempotently and builds a verified sequence-to-operation map.
  Direct device-to-device cloning and merging independently upgraded spaces
  are outside this workflow. The retained v1 outbox is frozen history and is
  never sent by these commands.
- **Publication:** Setup validates the standalone copy (SQLite integrity,
  foreign keys, role, and sync history/sequence and projection checks). It
  fsyncs an exclusive mode-0600 staged file and publishes it with a
  same-directory no-overwrite link, then fsyncs the directory. A newly created
  `.memory-db` directory uses mode 0700; existing root and directory permissions
  are caller-managed. Dry runs validate without publishing. An interruption
  can leave a mode-0600 `.snapshot-*.tmp`; with destination writers stopped,
  remove just the stale staging name after confirming no setup is active.
  The final database is either absent or a complete snapshot; never discard a
  database or its sidecars to clear an uncertain setup outcome.
- **Push/pull:** Run `sync-push` and `sync-pull` on either device with the same
  `--relay` after edits, using `--limit 1..100` if desired (default 100).
  Each command handles one batch/page; repeat while `more` is true. Push
  reports `pushed` (acknowledged, including duplicates) and `pending`. It
  selects outbox entries in dependency-first log order and only acknowledges
  matching receipts after the relay transaction has durably committed. A crash
  between commit and acknowledgement leaves retryable outbox entries. Pull
  reports `pulled` (page size), durable `position` and the observed relay `head`.
  Failed pages leave the cursor unchanged. No transaction holds a lock on both
  databases; a busy error can be retried.
- **Identity and limits:** Each transfer checks the selected scope, space ID,
  genesis, and role. A bound device refuses a different relay stream and checks
  the last received operation against the relay. Use `sync-status` for role,
  stream, pending count and cursor or relay head. Updated runtime writers and
  conflict resolution refuse relay writes; keep the relay separate from runtime
  roots, including any old loaded writer. Never fork, roll back, or replace the
  active relay under attached devices. There is no detach, cursor reset,
  failover, pruning, authentication or encryption. Snapshots include plaintext
  documents and history; protect all three roots accordingly.

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
Public section-write tests use two synthetic replicas and a relay, covering
disjoint merges, same-section and parent/child conflicts, the maximum timestamp,
stale revisions, malformed timestamp rollback, and structural fallback.
Resolution tests cover same-section/ancestor selection with a disjoint visible
edit, exact token guards even for unchanged raw and pairs, manual merges and
dependent history, replay/duplicates, late/concurrent resolutions and edits,
tombstone races, malformed-page rollback and the v1 CLI boundary. The publish
image's synthetic Bun check includes the sync suite. Verification for local
resolution: 111 Bun tests, 113 Python tests, and `git diff --check` passed.

The operator CLI suite runs real synthetic first-device/relay/new-device
lifecycles, including committed WAL visibility, pending dependencies, tombstones,
disjoint edits, conflicts and resolution, crash before acknowledgement, invalid
receipts, failed page application, pagination, concurrent snapshot publication,
and role/identity/path refusals. The publish image check includes this suite.
Verification for local relay: 107 Bun memory tests, 11 Bun MCP tests, 113 Python
tests, and `git diff --check` passed. The current rebuild algorithm recomputes
the retained DAG and is intended for small histories. Incremental indexing and
scale testing are still required. Do not manually edit operation payloads,
outboxes or conflict tables.

Worker/D1 conditional-write races, HTTP transport, authentication/revocation,
encryption, key recovery, deployment, tombstone restoration, general backup/restore tooling, stream reset and
multi-relay support remain deferred. The previously verified official references
are in [the SQLite milestone](memory-sqlite-milestone.md#verified-sources-2026-11-16).
Local SQLite and sync execution stay trusted plaintext; optional cryptography
belongs at the future upload/download boundary. Cloudflare semantics and current
limits must be rechecked before implementing that boundary.
