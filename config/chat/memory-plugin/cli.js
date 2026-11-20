import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createMemoryStore } from "./backend.js";
import { importMarkdown, exportMarkdown, safeRoot } from "./transfer.js";
import { upgradeSync, syncStatus } from "./upgrade.js";
import { conflictName, documentConflicts } from "./sync-admin.js";
import { MAX_SYNC_RAW, resolutionChoice } from "./sync-prototype.js";
import { bootstrapLocal, transferLocal } from "./sync-local.js";

const help = `Usage: memory.sh <command> [OPTIONS]

Commands:
  init                      Initialize selected SQLite spaces, safely repeatable
  upgrade-sync              Explicit v1 -> v2 upgrade with standalone v1 backup
  sync-status                Read local schema, role, pending count, conflicts and cursor
  sync-relay-init            Copy an upgraded device into a new marked local relay
  sync-bootstrap             Copy a marked local relay into a new device
  sync-push                 Transfer one pending batch from device to local relay
  sync-pull                 Apply one page from local relay to device
  conflicts NAME            Inspect one exact v2 document and its active conflict branches
  resolve --input FILE|-     Resolve inspected conflicts on one v2 document
  import --source DIR       Import Markdown into --root (destination); explicit only
  migrate --source DIR      Alias for import; source is never modified
  export --destination DIR  Export raw Markdown to a new directory
  recall                    Review summary/navigation and five recent records
  search QUERY              Search literal, whitespace-separated terms
  read NAME                 Read MEMORY.md, INDEX.md, or a returned filename
  record --input FILE|-      Save a topic from JSON and rebuild its index
  update --input FILE|-      Update the Markdown body of MEMORY.md or a session record
  delete --input FILE|-      Delete a session record with a revision (SQLite v2 only)

Options (also accept --flag=VALUE):
  --root DIR                Absolute SQLite destination/runtime root (or MEMORY_ROOT)
  --backend sqlite          SQLite only; Markdown runtime is rejected
  --source DIR              Absolute Markdown source root for import/migrate
  --destination DIR         Absolute new output root for export
  --dry-run                 Preview init/import/migrate/export/upgrade-sync or snapshot setup
  --space shared|private|both
                            Default shared; both supports reads and administration
  --relay DIR                Absolute local relay root for sync-relay-init/bootstrap/push/pull
                            These commands require explicit --root and --space shared|private
  --limit N                  Search matches (1..20), read characters (1..20000),
                            or sync-push/pull batch size (1..100, default 100)
  --offset N                Read body offset in characters (default: 0)
  --section TITLE           Exact heading title without #; read only (not INDEX.md)
                            Includes nested sections; pagination is section-relative
  --input FILE|-            JSON file, or - for stdin; required for writes
  --request-id ID           Stable record retry key; default: generated UUID
  -h, --help                Show help without accessing memory
  --                        End flags (for queries starting with a dash)

Record JSON:
  {"topic":"short-slug","goal":"...","conclusion":"...","details":"Markdown..."}
  Optional string fields: decisions, nextSteps, preferences.
Update JSON:
  {"content":"Complete merged Markdown body","expectedRevision":"from read"}
  Optional name selects an existing session record instead of MEMORY.md.
  Update changes the body and updated_at; the stored summary stays unchanged.
  Optional section selects one section to replace, including its
  unchanged heading title/level. Read every selected-section page first; for
  full updates read every whole-body page (omit --section). Section reads return the
  full-file revision and metadata; missing/duplicate titles fail explicitly.
  Recall reports missing summaries; use read MEMORY.md to retrieve details.
Delete JSON:
  {"name":"2026-01-01-topic.md","expectedRevision":"from read"}
  Requires an existing session record and its current full revision.
  SQLite v2 retains a tombstone and history; MEMORY.md and INDEX.md are protected.
Resolve JSON:
  {"name":"MEMORY.md","expectedRevision":"from conflicts","conflictToken":"from conflicts","branchId":"operationId from conflicts"}
  Or use "content":"Complete merged Markdown body" instead of branchId.
  One space (shared by default), no YAML frontmatter, no tombstone recovery.

Successful operations print one JSON object to stdout. Errors print a JSON
error to stderr: exit 2 for usage/input, 1 for an operation failure. No LLM or
OpenCode server is needed. Requires Bun with built-in YAML support.
Record results use logicalPath (logical SQLite identifier) and name (.md).
upgrade-sync requires all writers stopped; preview with --dry-run first.
New databases remain v1 until explicit upgrade. No cloud transport is enabled.

Space is caller-selected, not authenticated. The default never reads private
memory. Use the same --request-id for retries of one record; choose a different
ID for a new record. The returned requestId can be reused after a successful call.
`;

class UsageError extends Error {}
const usageError = (message) => { throw new UsageError(message); };
const localSnapshots = ["sync-relay-init", "sync-bootstrap"];
const localTransfers = ["sync-push", "sync-pull"];
const localCommands = [...localSnapshots, ...localTransfers];
const allowed = {
  "upgrade-sync": ["root", "space", "dry-run"],
  "sync-status": ["root", "space"],
  "sync-relay-init": ["root", "space", "relay", "dry-run"],
  "sync-bootstrap": ["root", "space", "relay", "dry-run"],
  "sync-push": ["root", "space", "relay", "limit"],
  "sync-pull": ["root", "space", "relay", "limit"],
  conflicts: ["root", "space"],
  resolve: ["root", "space", "input"],
  init: ["root", "space", "dry-run"],
  import: ["root", "source", "space", "dry-run"],
  migrate: ["root", "source", "space", "dry-run"],
  export: ["root", "destination", "space", "dry-run"],
  recall: ["root", "space"],
  search: ["root", "space", "limit"],
  read: ["root", "space", "limit", "offset", "section"],
  record: ["root", "space", "input", "request-id"],
  update: ["root", "space", "input"],
  delete: ["root", "space", "input"],
};

function parse(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === "--") { positional.push(...args.slice(i + 1)); break; }
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("-")) { positional.push(argument); continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(argument);
    if (!match || !["backend", "root", "source", "destination", "relay", "dry-run", "space", "limit", "offset", "section", "input", "request-id"].includes(match[1])) {
      usageError(`Unknown option: ${argument}. Use --help for usage.`);
    }
    const key = match[1];
    if (key === "dry-run") {
      if (match[2] !== undefined) usageError("--dry-run accepts no value.");
      options[key] = true;
      continue;
    }
    let value = match[2];
    if (value === undefined) {
      value = args[++i];
      if (value === undefined || value.startsWith("--") || value === "-h") usageError(`--${key} requires a value.`);
    }
    if (!value) usageError(`--${key} requires a non-empty value.`);
    options[key] = value;
  }
  const command = positional.shift();
  if (!Object.hasOwn(allowed, command)) usageError(`Choose ${Object.keys(allowed).join(", ")}. Use --help for usage.`);
  for (const key of Object.keys(options)) {
    if (key !== "backend" && !allowed[command].includes(key)) usageError(`--${key} is not supported by ${command}.`);
  }
  const operands = ["search", "read", "conflicts"].includes(command) ? 1 : 0;
  if (positional.length !== operands) usageError(`${command} requires ${operands} positional argument(s); quote a multi-word query.`);
  const space = options.space ?? "shared";
  if (!["shared", "private", "both"].includes(space)) usageError("--space must be shared, private, or both.");
  const writing = ["record", "update", "delete", "resolve"].includes(command);
  if (writing && space === "both") usageError("Write to one space at a time.");
  if (command === "conflicts" && space === "both") usageError("Conflict inspection requires one explicit space at a time.");
  if (localCommands.includes(command)) {
    if (!options.space || space === "both") usageError(`${command} requires explicit --space shared or private.`);
    if (!options.root || !path.isAbsolute(options.root) || !options.relay || !path.isAbsolute(options.relay)) {
      usageError(`${command} requires explicit absolute --root DIR and --relay DIR.`);
    }
    if ([options.root, options.relay].some((value) => value.split(path.sep).includes(".."))) {
      usageError("Local sync roots must not contain '..' path components.");
    }
  }
  if (command === "conflicts" && !conflictName(positional[0])) usageError("Use MEMORY.md or an exact session record filename without directories.");
  if (writing && !options.input) usageError(`${command} requires --input FILE or --input - for stdin.`);
  if (["import", "migrate"].includes(command) && !options.source) usageError(`${command} requires --source DIR.`);
  if (command === "export" && !options.destination) usageError("export requires --destination DIR.");
  for (const key of ["limit", "offset"]) {
    if (options[key] === undefined) continue;
    if (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) usageError(`--${key} must be an integer.`);
    options[key] = Number(options[key]);
    const max = localTransfers.includes(command) ? 100 : command === "search" ? 20 : 20000;
    if (key === "limit" && (options[key] < 1 || options[key] > max)) {
      usageError(`--limit must be between 1 and ${max}.`);
    }
  }
  if (options["request-id"] && options["request-id"].length > 200) usageError("--request-id must be at most 200 characters.");
  return { command, options, space, operand: positional[0], writing };
}

async function inputJSON(filename, command) {
  if (filename === "-" && process.stdin.isTTY) usageError("Pipe JSON to stdin when using --input -.");
  const raw = filename === "-" ? await Bun.stdin.text() : await readFile(filename, "utf8");
  const limit = command === "resolve" ? 6 * MAX_SYNC_RAW + 1000 : 100_000;
  if (raw.length > limit) usageError(`JSON input must be at most ${limit} characters.`);
  let input;
  try { input = JSON.parse(raw); } catch { usageError("Input must be valid JSON."); }
  if (!input || typeof input !== "object" || Array.isArray(input)) usageError("Input must be a JSON object.");
  const [required, optional] = {
    record: [["topic", "goal", "conclusion", "details"], ["decisions", "nextSteps", "preferences"]],
    update: [["content", "expectedRevision"], ["name", "section"]],
    delete: [["name", "expectedRevision"], []],
    resolve: [["name", "expectedRevision", "conflictToken"], ["branchId", "content"]],
  }[command];
  const fields = [...required, ...optional];
  for (const [key, value] of Object.entries(input)) {
    if (!fields.includes(key)) usageError(`Unknown input field: ${key}. Select memory space with --space.`);
    if (typeof value !== "string") usageError(`${key} must be a string.`);
  }
  for (const key of required) if (!input[key]?.trim()) usageError(`${key} must be a non-empty string.`);
  if (command === "record" && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.topic) || input.topic.length > 80)) {
    usageError("topic must be an English/pinyin slug of at most 80 characters.");
  }
  if (command === "resolve") {
    if (!conflictName(input.name)) usageError("Use MEMORY.md or an exact session record filename without directories.");
    for (const key of ["expectedRevision", "conflictToken"]) {
      if (!/^[a-f0-9]{64}$/.test(input[key])) usageError(`${key} must be the SHA-256 value from conflicts.`);
    }
    if (!resolutionChoice(input)) {
      usageError("Supply exactly one active branchId or a non-empty merged Markdown content without YAML frontmatter.");
    }
  }
  return input;
}

export async function run(args, env = process.env) {
  const parsed = parse(args);
  if (parsed.help) return { help };
  const { command, options, space, operand, writing } = parsed;
  const backend = options.backend ?? env.MEMORY_BACKEND ?? "sqlite";
  const explicitRoot = options.root ?? env.MEMORY_ROOT;
  if (!explicitRoot || !path.isAbsolute(explicitRoot)) usageError("SQLite requires an explicit absolute --root or MEMORY_ROOT.");
  const root = path.resolve(explicitRoot);
  if (localCommands.includes(command)) {
    createMemoryStore(root, { backend }); // Validate the selected backend without opening it.
    const settings = { root, relayRoot: path.resolve(options.relay), scope: space };
    return { result: await (localSnapshots.includes(command) ?
      bootstrapLocal({ ...settings, initializeRelay: command === "sync-relay-init", dryRun: options["dry-run"] }) :
      transferLocal({ ...settings, push: command === "sync-push", limit: options.limit ?? 100 })) };
  }
  if (!(await stat(root)).isDirectory()) usageError("--root must refer to an existing directory.");
  const store = createMemoryStore(root, { backend });
  if (["upgrade-sync", "sync-status"].includes(command)) {
    if (space === "both") usageError("Sync administration requires one explicit space at a time.");
    return { result: await (command === "upgrade-sync" ? upgradeSync : syncStatus)({ root, scope: space, dryRun: options["dry-run"] ?? false }) };
  }
  if (command === "conflicts") return { result: await documentConflicts(store, space, operand) };
  if (command === "resolve") {
    const { name, ...resolution } = await inputJSON(options.input, command);
    return { result: await documentConflicts(store, space, name, resolution) };
  }
  if (["init", "import", "migrate", "export"].includes(command)) {
    const dryRun = options["dry-run"] ?? false;
    if (command === "import" || command === "migrate") return { result: await importMarkdown({ root, source: options.source, scope: space, dryRun }) };
    if (command === "export") return { result: await exportMarkdown({ root, destination: options.destination, scope: space, dryRun }) };
    await safeRoot(root);
    const selected = space === "both" ? ["shared", "private"] : [space];
    for (const scope of selected) await store.connection(scope, () => {});
    const result = [];
    for (const scope of selected) result.push(dryRun ? { scope } : await store.init(scope));
    return { result: { dryRun, spaces: result } };
  }
  // Reuse store policies without pretending this CLI has a host-authenticated
  // agent identity. A caller explicitly choosing private/both opts into it.
  const agent = space === "shared" ? "serious" : "casual";
  let input = { scope: space };
  if (writing) input = { ...await inputJSON(options.input, command), scope: space };
  if (command === "search") {
    if (!operand.trim() || operand.length > 500) usageError("query must be non-empty and at most 500 characters.");
    input.query = operand;
  }
  if (command === "read") input.name = operand;
  for (const key of ["limit", "offset", "section"]) if (options[key] !== undefined) input[key] = options[key];
  if (command === "record") {
    const requestId = options["request-id"] ?? randomUUID();
    return { result: { ...await store.record(agent, input, `cli:${requestId}`), requestId } };
  }
  return { result: await store[command](agent, input) };
}

if (import.meta.main) {
  try {
    const output = await run(process.argv.slice(2));
    console.log(output.help ?? JSON.stringify(output.result));
  } catch (error) {
    const usage = error instanceof UsageError;
    console.error(JSON.stringify({ error: { code: usage ? "USAGE" : "OPERATION_FAILED", message: error.message } }));
    process.exitCode = usage ? 2 : 1;
  }
}
