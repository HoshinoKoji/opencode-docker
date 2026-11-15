import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decode, digest, encode, legacyMetadata } from "./format.js";
import { MemoryStore } from "./store.js";

export async function migrate(root, { scopes = ["shared", "private"], dryRun = false } = {}) {
  const store = new MemoryStore(root);
  for (const scope of scopes) store.relative(scope, "MEMORY.md");
  const run = async () => {
    const plans = [];
    const snapshots = [];
    const skippedEmpty = [];
    // Preflight every selected file before writing anything. Malformed or newer
    // frontmatter is an error, never something to silently replace.
    for (const scope of scopes) {
      for (const name of [...await store.names(scope), "INDEX.md"]) {
        const relative = await store.source(scope, name);
        const original = await store.text(relative);
        if (!original) {
          try {
            await stat(await store.checked(relative));
            skippedEmpty.push(relative);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          continue;
        }
        snapshots.push({ scope, name, relative, original });
        if (name === "INDEX.md") continue;
        const document = decode(original);
        if (document.metadata) continue;
        const modifiedAt = (await stat(await store.checked(relative))).mtime.toISOString();
        const metadata = legacyMetadata(scope, name, document.body, modifiedAt);
        const content = encode(metadata, document.body);
        if (decode(content).body !== original) throw new Error(`Migration would change the body: ${relative}`);
        plans.push({ scope, relative, original, content });
      }
      await store.entries(scope); // Also detect duplicate IDs before any writes.
    }
    const report = { files: plans.length, byScope: Object.fromEntries(scopes.map((scope) =>
      [scope, plans.filter((plan) => plan.scope === scope).length])), backups: [], skippedEmpty, dryRun };
    if (dryRun || !plans.length) return report;

    const batch = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    // Backup both files and old indexes, in their own access spaces. The manifest
    // records the original path and checksum, including shared root MEMORY.md.
    for (const scope of scopes) {
      const files = snapshots.filter((snapshot) => snapshot.scope === scope);
      if (!files.length) continue;
      const directory = path.join(path.dirname(store.relative(scope, "INDEX.md")), ".backups", batch);
      const absolute = await store.checked(directory);
      await mkdir(absolute, { recursive: true, mode: 0o700 });
      for (const file of files) await writeFile(path.join(absolute, file.name), file.original, { flag: "wx", mode: 0o600 });
      await writeFile(path.join(absolute, "manifest.json"), JSON.stringify({
        schema_version: 1, scope, files: files.map(({ name, relative, original }) =>
          ({ backup: name, path: relative, sha256: digest(original) })),
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      report.backups.push(directory);
    }
    for (const snapshot of snapshots) {
      if (await store.text(snapshot.relative) !== snapshot.original) throw new Error(`File changed during migration: ${snapshot.relative}`);
    }
    for (const plan of plans) {
      if (await store.text(plan.relative) !== plan.original) throw new Error(`File changed during migration: ${plan.relative}`);
      await store.atomic(plan.relative, plan.content);
    }
    for (const scope of scopes) await store.rebuild(scope);
    return report;
  };
  return dryRun ? run() : store.locked(run);
}

export async function relocateShared(root, { dryRun = false } = {}) {
  const store = new MemoryStore(root);
  const run = () => store.relocateShared({ dryRun });
  return dryRun ? run() : store.locked(run);
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "--help" || command === "-h") {
      console.log("Usage: bun config/chat/memory-plugin/manage.js <migrate|reindex|relocate-shared> [--root DIR] [--scope shared|private|both] [--dry-run]\nDefaults: root=current directory, scope=both (relocate-shared: shared only). Migration adds metadata; relocate-shared moves root MEMORY.md byte-for-byte into .sessions/MEMORY.md with a verified backup. Reindex writes only derived INDEX.md files.");
    } else {
      if (!["migrate", "reindex", "relocate-shared"].includes(command)) throw new Error("Choose migrate, reindex, or relocate-shared; use --help for usage.");
      let root = process.cwd();
      let scope = command === "relocate-shared" ? "shared" : "both";
      let dryRun = false;
      for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (flag === "--dry-run") { dryRun = true; continue; }
        if (!["--root", "--scope"].includes(flag) || !args[i + 1] || args[i + 1].startsWith("--")) {
          throw new Error(`Invalid argument or missing value: ${flag}`);
        }
        const value = args[++i];
        if (flag === "--root") root = path.resolve(value);
        else scope = value;
      }
      if (!["shared", "private", "both"].includes(scope)) throw new Error("scope must be shared, private, or both.");
      const scopes = scope === "both" ? ["shared", "private"] : [scope];
      if (command === "relocate-shared") {
        if (scope !== "shared") throw new Error("relocate-shared accepts only --scope shared.");
        console.log(JSON.stringify(await relocateShared(root, { dryRun }), null, 2));
      } else if (command === "migrate") console.log(JSON.stringify(await migrate(root, { scopes, dryRun }), null, 2));
      else {
        const store = new MemoryStore(root);
        if (dryRun) {
          for (const space of scopes) await store.entries(space);
          console.log(JSON.stringify({ scopes, dryRun: true }));
        } else console.log(JSON.stringify({ indexes: await store.locked(() => Promise.all(scopes.map((space) => store.rebuild(space)))) }));
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
