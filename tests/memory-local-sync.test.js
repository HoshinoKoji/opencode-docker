import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const wrapper = path.resolve(import.meta.dir, "../memory.sh");
const plugin = path.resolve(import.meta.dir, "../config/chat/memory-plugin");
const roots = [];
const twoSections = "# Memory\n## Left\ninitial left\n## Right\ninitial right\n";
const record = { topic: "synthetic-relay", goal: "Fixture", conclusion: "Done", details: "合成记录" };
const dbPath = (root, scope = "shared") => path.join(root, ".memory-db", `${scope}.sqlite`);

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "memory-local-sync-test-"));
  roots.push(cwd);
  const other = async (name) => {
    const root = path.join(cwd, name);
    await mkdir(root);
    return root;
  };
  const first = await other("first device"), relay = await other("relay"), second = await other("second device");
  const env = { ...process.env, MEMORY_ROOT: first, MEMORY_BACKEND: "sqlite" };
  const call = (args, input) => spawnSync("sh", [wrapper, ...args], {
    cwd, env, input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 10000,
  });
  const args = (command, root = first, remote = relay, ...flags) =>
    [command, "--root", root, "--relay", remote, "--space=shared", ...flags];
  const ok = (args, input) => {
    const result = call(args, input);
    if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.stderr || result.error || result.signal}`);
    return JSON.parse(result.stdout);
  };
  const fail = (args, text, code = 1, input) => {
    const result = call(args, input);
    expect(result.status).toBe(code);
    expect(result.stderr).toContain(text);
  };
  const local = (...rest) => ok(args(...rest));
  const status = (root) => ok(["sync-status", "--root", root]);
  const read = (root, name = "MEMORY.md") => ok(["read", name, "--root", root]).results[0];
  const edit = (root, content, section) => ok(["update", "--root", root, "--input=-"],
    { content, section, expectedRevision: read(root).revision });
  const upgraded = () => {
    edit(first, twoSections);
    return ok(["upgrade-sync"]);
  };
  const setup = () => {
    upgraded();
    const info = local("sync-relay-init");
    local("sync-bootstrap", second);
    return info;
  };
  return { cwd, env, first, second, relay, other, args, ok, fail, local, status, read, edit, upgraded, setup };
}

function onDB(root, fn) {
  const db = new Database(dbPath(root), { create: false, strict: true });
  try { return fn(db); } finally { db.close(); }
}

test("CLI snapshots WAL-visible v2 history, pending dependencies and tombstones", async () => {
  const { first, second, relay, local, ok, status, read, edit, upgraded } = await fixture();
  const { spaceId } = upgraded();
  const keeper = new Database(dbPath(first), { create: false });
  try {
    keeper.query("SELECT * FROM sync_info").get();
    edit(first, "## Left\npending parent", "Left");
    edit(first, "## Left\npending child", "Left");
    const saved = ok(["record", "--input=-"], record);
    ok(["delete", "--input=-"], { name: saved.name, expectedRevision: saved.revision });
    expect((await lstat(dbPath(first) + "-wal")).size).toBeGreaterThan(32);
    expect(status(first)).toMatchObject({ role: "unbound", pending: 4 });
    expect(local("sync-relay-init", first, relay, "--dry-run")).toMatchObject({ role: "relay", dryRun: true, head: 4 });
    expect(await readdir(relay)).toEqual([]);
    // This active writer's uncommitted page must not leak into the snapshot.
    keeper.exec("BEGIN IMMEDIATE; UPDATE sync_info SET space = 'uncommitted'");
    const info = local("sync-relay-init");
    keeper.exec("ROLLBACK");
    expect(info).toMatchObject({ role: "relay", space: spaceId, head: 4 });
    expect(status(first)).toMatchObject({ role: "unbound", pending: 4 });
    expect(status(relay)).toMatchObject({ role: "relay", head: 4, pending: 0, stream: info.stream,
      tombstones: [{ id: saved.id }], cursor: null });
    expect(local("sync-bootstrap", second, relay, "--dry-run")).toMatchObject({ role: "device", dryRun: true, stream: info.stream });
    expect(await readdir(second)).toEqual([]);
    expect(local("sync-bootstrap", second)).toMatchObject({ role: "device", head: 4, space: spaceId, stream: info.stream });
    expect((await lstat(dbPath(second))).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(dbPath(second)))).mode & 0o777).toBe(0o700);
    expect(read(second)).toEqual(read(first));
    expect(read(second).text).toContain("pending child");
    expect(read(second, saved.name)).toMatchObject({ text: "", metadata: null });
    expect(ok(["conflicts", saved.name, "--root", second])).toMatchObject({ id: saved.id, deleted: true });
    expect(status(second)).toMatchObject({ role: "device", pending: 0, cursor: { stream: info.stream, position: 0 } });
    for (const table of ["documents", "versions", "outbox", "sync_seed", "sync_operations", "sync_versions", "sync_views", "sync_sections", "sync_log"]) {
      const rows = (root) => onDB(root, (db) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
      expect(rows(second)).toEqual(rows(first));
      expect(rows(relay)).toEqual(rows(first));
    }
    expect(local("sync-push", second)).toMatchObject({ pushed: 0, more: false });
    edit(second, "## Left\nnew device built on pending ancestor", "Left");
    expect(local("sync-push", second)).toMatchObject({ pushed: 1, pending: 0 });
    expect(local("sync-push", first, relay, "--limit=2")).toMatchObject({ pushed: 2, pending: 2, more: true });
    expect(local("sync-push")).toMatchObject({ pushed: 2, pending: 0, more: false });
    expect(status(relay).head).toBe(5);
    expect(local("sync-pull", second, relay, "--limit=2")).toMatchObject({ pulled: 2, position: 2, more: true });
    expect(local("sync-pull", second)).toMatchObject({ pulled: 3, position: 5, more: false });
    expect(local("sync-pull", second)).toMatchObject({ pulled: 0, position: 5, more: false });
    expect(local("sync-pull")).toMatchObject({ pulled: 5, position: 5, more: false });
    expect(read(first).text).toContain("new device built on pending ancestor");
  } finally { keeper.close(); }
});

test("CLI live devices merge disjoint edits, retain same-section conflicts, and replay resolution", async () => {
  const { first, second, relay, local, ok, read, edit, status, setup } = await fixture();
  setup();
  for (const [left, section, right] of [["first independent edit", "Right", "second independent edit"],
    ["first conflict arm", "Left", "second conflict arm"]]) {
    edit(first, `## Left\n${left}`, "Left");
    edit(second, `## ${section}\n${right}`, section);
    for (const root of [first, second]) local("sync-push", root);
    for (const root of [first, second]) local("sync-pull", root);
    expect(read(first)).toEqual(read(second));
    if (section === "Right") {
      expect(read(first).text).toContain(left);
      expect(read(first).text).toContain(right);
    }
  }
  const inspected = ok(["conflicts", "MEMORY.md"]);
  expect(inspected).toEqual(ok(["conflicts", "MEMORY.md", "--root", second]));
  expect(inspected.conflicts).toHaveLength(1);
  const choice = inspected.branches.find(({ raw }) => raw.includes("second conflict arm"));
  const resolved = ok(["resolve", "--input=-"], { name: "MEMORY.md", expectedRevision: inspected.revision,
    conflictToken: inspected.conflictToken, branchId: choice.operationId });
  expect(local("sync-push")).toMatchObject({ pushed: 1, pending: 0 });
  expect(local("sync-push")).toMatchObject({ pushed: 0 });
  expect(local("sync-pull", second)).toMatchObject({ pulled: 1, position: 5 });
  expect(local("sync-pull", second)).toMatchObject({ pulled: 0, position: 5 });
  expect(read(second).revision).toBe(resolved.revision);
  expect(read(second).text.trimEnd()).toBe("# Memory\n## Left\nsecond conflict arm\n\n## Right\nsecond independent edit");
  expect(status(second).conflicts).toEqual([]);
  expect(status(relay)).toMatchObject({ head: 5, pending: 0, conflicts: [] });
  expect(onDB(relay, (db) => db.query("SELECT count(*) AS n FROM sync_versions").get()).n).toBe(5);
});

test("CLI dependency-ordered push survives a crash before ack; failed pull does not advance cursor", async () => {
  const { first, second, relay, fail, status, local, args, edit, setup, env, cwd, read } = await fixture();
  setup();
  edit(first, "## Left\nfirst parent", "Left");
  edit(first, "## Left\nsecond child", "Left");
  const program = `
    import { SyncPrototype } from ${JSON.stringify(path.join(plugin, "sync-prototype.js"))};
    import { run } from ${JSON.stringify(path.join(plugin, "cli.js"))};
  `;
  const child = (patch) => spawnSync("bun", ["-e", `${program}${patch}
    await run(${JSON.stringify(args("sync-push", first, relay, "--limit=1"))});
  `], { cwd, env, encoding: "utf8", timeout: 10000 });
  const killed = child(`SyncPrototype.prototype.acknowledge = () => process.kill(process.pid, "SIGKILL");`);
  expect(killed.signal).toBe("SIGKILL");
  expect(status(first)).toMatchObject({ role: "device", pending: 2 });
  expect(status(relay).head).toBe(1);
  const invalidReceipt = child(`const push = SyncPrototype.prototype.push;
    SyncPrototype.prototype.push = function (batch) { return push.call(this, batch).map((receipt) => ({ ...receipt, digest: "bad" })); };
  `);
  expect(invalidReceipt.status).toBe(1);
  expect(invalidReceipt.stderr).toContain("Invalid relay receipts");
  expect(status(first).pending).toBe(2);
  expect(local("sync-push", first, relay, "--limit=1")).toMatchObject({ pushed: 1, pending: 1, more: true });
  expect(status(relay).head).toBe(1);
  expect(local("sync-push", first, relay, "--limit=1")).toMatchObject({ pushed: 1, pending: 0, more: false });
  expect(status(relay).head).toBe(2);
  expect(local("sync-pull", second, relay, "--limit=1")).toMatchObject({ position: 1, more: true });
  expect(read(second).text).toContain("first parent");
  onDB(second, (db) => db.exec(`CREATE TRIGGER fail_page BEFORE INSERT ON sync_inbox
    BEGIN SELECT RAISE(ABORT, 'synthetic receive failure'); END`));
  fail(args("sync-pull", second), "synthetic receive failure");
  expect(status(second).cursor.position).toBe(1);
  expect(read(second).text).toContain("first parent");
  onDB(second, (db) => db.exec("DROP TRIGGER fail_page"));
  expect(local("sync-pull", second)).toMatchObject({ position: 2, more: false });
  expect(read(second).text).toContain("second child");
  onDB(relay, (db) => db.exec("DELETE FROM sync_log WHERE sequence = 2"));
  fail(args("sync-pull", second), "refusing to reset");
  expect(status(second).cursor.position).toBe(2);
});

test("CLI rejects v1 and role, scope, genesis, stream, or root mismatch without resetting cursor", async () => {
  const { first, second, relay, fail, local, args, ok, status, edit, other } = await fixture();
  fail(args("sync-relay-init"), "existing SQLite schema v2");
  ok(["init"]);
  fail(args("sync-relay-init"), "requires SQLite schema v2");
  expect(status(first)).toMatchObject({ schema: 1, upgradeRequired: true });
  expect(await readdir(relay)).toEqual([]);
  fail(["sync-relay-init", "--relay", relay, "--space=shared"], "explicit absolute", 2);
  fail(["sync-relay-init", "--relay", relay, "--root", first], "explicit --space", 2);
  fail(args("sync-relay-init", first, "relative"), "explicit absolute", 2);
  fail(args("sync-relay-init", first, `${relay}/../relay`), "'..' path components", 2);
  fail(args("sync-relay-init", first, relay, "--space=both"), "explicit --space", 2);
  fail(args("sync-pull", first, relay, "--limit=101"), "between 1 and 100", 2);
  fail(args("sync-push", first, relay, "--limit=0"), "between 1 and 100", 2);
  fail(args("sync-relay-init", first, first), "distinct roots");
  fail(args("sync-relay-init", first, path.join(relay, "missing")), "ENOENT");
  ok(["upgrade-sync"]);
  edit(first, twoSections);
  const alternate = await other("other relay from same origin");
  local("sync-relay-init", first, alternate);
  const marked = local("sync-relay-init");
  const v1 = await other("other v1");
  ok(["init", "--root", v1]);
  fail(args("sync-push", v1), "requires SQLite schema v2");
  fail(args("sync-pull", v1), "requires SQLite schema v2");
  expect(status(v1)).toMatchObject({ schema: 1, upgradeRequired: true });
  fail(args("sync-bootstrap", second, first), "explicitly marked relay");
  local("sync-bootstrap", second);
  local("sync-pull", second);
  const cursor = status(second).cursor;
  expect(cursor).toMatchObject({ stream: marked.stream, position: 1 });
  for (const command of ["sync-pull", "sync-push"]) {
    fail(args(command, second, alternate), "different local sync stream");
    fail(args(command, second, first), "explicitly marked relay");
    fail(args(command, relay, second), "device and an explicitly marked relay");
  }
  fail(args("sync-bootstrap", second), "must not exist");
  fail(args("sync-relay-init"), "must not exist");
  fail(args("sync-relay-init", second, await other("spare relay")), "unbound upgraded device");
  fail(["record", "--root", relay, "--input=-"], "Regular memory writes are disabled", 1, record);
  fail(["init", "--root", relay], "Regular memory writes are disabled");
  fail(["resolve", "--root", relay, "--input=-"], "Regular memory writes are disabled", 1,
    { name: "MEMORY.md", expectedRevision: "1".repeat(64), conflictToken: "2".repeat(64), content: "No" });
  expect(status(second).cursor).toEqual(cursor);
  expect(status(relay)).toMatchObject({ role: "relay", head: 1, pending: 0 });
  onDB(second, (db) => db.query("UPDATE sync_info SET genesis = ?").run("f".repeat(64)));
  fail(args("sync-pull", second), "space ID or genesis mismatch");
  onDB(second, (db) => db.query("UPDATE sync_info SET space = ?, genesis = ?").run("wrong-space", marked.genesis));
  fail(args("sync-push", second), "space ID or genesis mismatch");
  expect(status(second).cursor).toEqual(cursor);
  await copyFile(dbPath(relay), dbPath(relay, "private"));
  fail(args("sync-bootstrap", await other("wrong scope"), relay, "--space=private"), "database space mismatch");
});

test("CLI refuses bootstrap over databases or sidecars, unsafe links and invalid snapshots", async () => {
  const { first, second, relay, fail, args, upgraded, local, other } = await fixture();
  upgraded();
  const filename = dbPath(relay);
  const aliasRoot = path.join(path.dirname(relay), "relay alias");
  await symlink(relay, aliasRoot, "dir");
  fail(args("sync-relay-init", first, aliasRoot), "root symlinks");
  const aliasDirectory = await other("alias directory");
  await symlink(path.dirname(dbPath(first)), path.dirname(dbPath(aliasDirectory)), "dir");
  fail(args("sync-relay-init", first, aliasDirectory), "real directory");
  await mkdir(path.dirname(filename));
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    await writeFile(filename + suffix, "untouched");
    fail(args("sync-relay-init"), "must not exist");
    expect(await readFile(filename + suffix, "utf8")).toBe("untouched");
    await unlink(filename + suffix);
  }
  await symlink(path.join(relay, "nonexistent"), filename + "-shm");
  fail(args("sync-relay-init"), "must not exist");
  await unlink(filename + "-shm");
  local("sync-relay-init");
  await mkdir(path.dirname(dbPath(second)));
  await symlink(filename, dbPath(second));
  fail(args("sync-pull", second), "without symlinks or hardlinks");
  fail(args("sync-bootstrap", second), "must not exist");
  await unlink(dbPath(second));
  await link(filename, dbPath(second));
  fail(args("sync-pull", second), "without symlinks or hardlinks");
  await unlink(dbPath(second));
  onDB(relay, (db) => db.exec("INSERT INTO sqlite_sequence VALUES ('sync_log', 5)"));
  fail(args("sync-bootstrap", second), "Invalid snapshot sequence counter");
  expect(await readdir(path.dirname(dbPath(second)))).toEqual([]);
});

test("CLI transports only the explicitly selected private space", async () => {
  const { first, second, relay, ok, local } = await fixture();
  ok(["init", "--space=private"]);
  ok(["upgrade-sync", "--space=private"]);
  ok(["record", "--space=private", "--input=-"], record);
  await mkdir(path.dirname(dbPath(relay)));
  await mkdir(path.dirname(dbPath(second)));
  for (const root of [first, relay, second]) await symlink(path.join(root, "unread"), dbPath(root));
  local("sync-relay-init", first, relay, "--space=private");
  local("sync-bootstrap", second, relay, "--space=private");
  expect(local("sync-pull", second, relay, "--space=private")).toMatchObject({ scope: "private", position: 1 });
  expect(ok(["search", "合成记录", "--space=private", "--root", second]).matches).toBe(1);
  for (const root of [first, relay, second]) expect((await lstat(dbPath(root))).isSymbolicLink()).toBe(true);
});

test("CLI concurrent bootstrap publishes exactly one complete image", async () => {
  const { cwd, env, first, second, local, args, edit, read, upgraded } = await fixture();
  upgraded();
  edit(first, "## Left\npublished fixture", "Left");
  const { stream } = local("sync-relay-init");
  const attempt = () => Bun.spawn(["sh", wrapper, ...args("sync-bootstrap", second)], { cwd, env, stdout: "ignore", stderr: "ignore" });
  const processes = [attempt(), attempt()];
  expect((await Promise.all(processes.map((child) => child.exited))).sort()).toEqual([0, 1]);
  expect(await readdir(path.dirname(dbPath(second)))).toEqual(["shared.sqlite"]);
  expect(read(second)).toEqual(read(first));
  expect(local("sync-pull", second)).toMatchObject({ stream, position: 1 });
});
