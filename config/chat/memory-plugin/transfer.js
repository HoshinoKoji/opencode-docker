import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MemoryStore } from "./store.js";
import { SQLiteMemoryStore } from "./sqlite.js";
import { decode, encode, legacyMetadata } from "./format.js";

const spaces = (scope) => {
  if (!["shared", "private", "both"].includes(scope)) throw new Error("Invalid memory scope.");
  return scope === "both" ? ["shared", "private"] : [scope];
};

export async function safeRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Require an explicit absolute root.");
  let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Memory root symlinks are unsupported.");
    if (!info.isDirectory()) throw new Error("Memory root must be an existing directory.");
  }
}

async function exists(filename) {
  try { await lstat(filename); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function sourceDocuments(root, scope) {
  const store = new MemoryStore(root);
  const directory = scope === "shared" ? ".sessions" : ".sessions/casual";
  const absolute = await store.checked(directory);
  const names = await exists(absolute) ? await readdir(absolute) : [];
  // Validate only the selected space. Never inspect private children on shared imports.
  const selected = [];
  for (const name of names) {
    if (name === ".backups" || (scope === "shared" && name === "casual")) continue;
    // Git-backed memory folders may contain a repository or a worktree pointer.
    // These are administration artifacts, never documents; do not traverse them.
    if ([".git", ".gitignore", ".gitattributes", ".gitmodules"].includes(name)) continue;
    if (name === ".memory-lock") throw new Error("Source memory is locked; stop its writer before importing.");
    try { store.relative(scope, name); }
    catch { throw new Error(`Unsupported import entry: ${directory}/${name}. Expected MEMORY.md, INDEX.md or a dated memory document.`); }
    const filename = await store.checked(path.join(directory, name));
    if (!(await lstat(filename)).isFile()) throw new Error("Import sources must be regular files.");
    if (name !== "INDEX.md") selected.push(name);
  }
  const memory = await store.source(scope, "MEMORY.md"); // Also rejects canonical/legacy conflicts.
  if (await exists(await store.checked(memory)) && !selected.includes("MEMORY.md")) selected.push("MEMORY.md");
  const ids = new Set();
  const documents = [];
  for (const name of selected.sort()) {
    const filename = await store.checked(name === "MEMORY.md" ? memory : store.relative(scope, name));
    const bytes = await readFile(filename);
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw).equals(bytes)) throw new Error("Import requires losslessly decodable UTF-8 Markdown.");
    const document = decode(raw);
    const metadata = document.metadata ?? legacyMetadata(scope, name, document.body);
    encode(metadata, ""); // Validate synthesized legacy dates too; store the original raw bytes below.
    if (metadata.type !== (name === "MEMORY.md" ? "long_term" : "session")) throw new Error(`Incorrect metadata type: ${name}`);
    if (ids.has(metadata.id)) throw new Error(`Duplicate memory ID in ${scope}: ${metadata.id}`);
    ids.add(metadata.id);
    documents.push({ name, id: metadata.id, raw });
  }
  return documents;
}

function validateDestination(db, documents, store) {
  for (const doc of documents) {
    const prior = store.rows(db).filter((row) => row.name === doc.name || row.id === doc.id);
    if (prior.some((row) => row.name !== doc.name || row.id !== doc.id || row.raw !== doc.raw)) {
      throw new Error(`Destination conflict: ${doc.name}`);
    }
  }
}

export async function importMarkdown({ root, source, scope = "shared", dryRun = false }) {
  await safeRoot(root);
  await safeRoot(source);
  const store = new SQLiteMemoryStore(root);
  const batches = [];
  // Preflight every selected space before creating any database or importing data.
  for (const space of spaces(scope)) {
    const documents = await sourceDocuments(source, space);
    await store.connection(space, (db) => validateDestination(db, documents, store));
    batches.push({ scope: space, documents });
  }
  if (!dryRun) {
    for (const batch of batches) {
      await store.locked(async () => {
        validateDestination(store.transaction.getStore().db, batch.documents, store);
        for (const doc of batch.documents) await store.atomic(store.relative(batch.scope, doc.name), doc.raw);
      }, batch.scope);
    }
  }
  return { dryRun, source, destination: root, spaces: batches.map((batch) => ({ scope: batch.scope, documents: batch.documents.length })) };
}

export async function exportMarkdown({ root, destination, scope = "shared", dryRun = false }) {
  await safeRoot(root);
  if (!destination || !path.isAbsolute(destination)) throw new Error("Require an explicit absolute destination.");
  await safeRoot(path.dirname(destination));
  if (await exists(destination)) throw new Error("Export destination must not exist.");
  const store = new SQLiteMemoryStore(root);
  const files = [];
  for (const space of spaces(scope)) {
    const rows = await store.connection(space, (db) => store.rows(db));
    for (const row of rows) files.push({ relative: store.relative(space, row.name), raw: row.raw });
  }
  if (!dryRun) {
    await mkdir(destination, { mode: 0o700 }); // Exclusive ownership; never overwrite an existing destination.
    try {
      for (const file of files) {
        const filename = path.join(destination, file.relative);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, file.raw, { flag: "wx", mode: 0o600 });
      }
    } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
  }
  return { dryRun, source: root, destination, documents: files.length };
}
