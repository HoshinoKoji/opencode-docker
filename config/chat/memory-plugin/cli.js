import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MemoryStore } from "./store.js";

const help = `Usage: memory.sh <command> [OPTIONS]

Commands:
  recall                    Review long-term memory and five recent records
  search QUERY              Search literal, whitespace-separated terms
  read NAME                 Read MEMORY.md, INDEX.md, or a returned filename
  record --input FILE|-      Save a topic from JSON and rebuild its index
  update --input FILE|-      Update long-term memory from JSON with a revision

Options (also accept --flag=VALUE):
  --root DIR                Memory workspace (default: MEMORY_ROOT, then cwd)
  --space shared|private|both
                            Space to use (default: shared; both is read-only)
  --limit N                 Search matches (1..20) or read characters (1..20000)
  --offset N                Read body offset in characters (default: 0)
  --input FILE|-            JSON file, or - for stdin; required for writes
  --request-id ID           Stable record retry key; default: generated UUID
  -h, --help                Show help without accessing memory
  --                        End flags (for queries starting with a dash)

Record JSON:
  {"topic":"short-slug","goal":"...","conclusion":"...","details":"Markdown..."}
  Optional string fields: decisions, nextSteps, preferences.
Update JSON:
  {"content":"Complete merged Markdown body","expectedRevision":"from read"}
  Read every page first. YAML metadata is maintained by the store.

Successful operations print one JSON object to stdout. Errors print a JSON
error to stderr: exit 2 for usage/input, 1 for an operation failure. No LLM or
OpenCode server is needed. Requires Bun with built-in YAML support.

Space is caller-selected, not authenticated. The default never reads private
memory. Use the same --request-id for retries of one record; choose a different
ID for a new record. The returned requestId can be reused after a successful call.
`;

class UsageError extends Error {}
const usageError = (message) => { throw new UsageError(message); };
const allowed = {
  recall: ["root", "space"],
  search: ["root", "space", "limit"],
  read: ["root", "space", "limit", "offset"],
  record: ["root", "space", "input", "request-id"],
  update: ["root", "space", "input"],
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
    if (!match || !["root", "space", "limit", "offset", "input", "request-id"].includes(match[1])) {
      usageError(`Unknown option: ${argument}. Use --help for usage.`);
    }
    const key = match[1];
    let value = match[2];
    if (value === undefined) {
      value = args[++i];
      if (value === undefined || value.startsWith("--") || value === "-h") usageError(`--${key} requires a value.`);
    }
    if (!value) usageError(`--${key} requires a non-empty value.`);
    options[key] = value;
  }
  const command = positional.shift();
  if (!Object.hasOwn(allowed, command)) usageError("Choose recall, search, read, record, or update. Use --help for usage.");
  for (const key of Object.keys(options)) {
    if (!allowed[command].includes(key)) usageError(`--${key} is not supported by ${command}.`);
  }
  const operands = command === "search" || command === "read" ? 1 : 0;
  if (positional.length !== operands) usageError(`${command} requires ${operands} positional argument(s); quote a multi-word query.`);
  const space = options.space ?? "shared";
  if (!["shared", "private", "both"].includes(space)) usageError("--space must be shared, private, or both.");
  const writing = command === "record" || command === "update";
  if (writing && space === "both") usageError("Write to one space at a time.");
  if (writing && !options.input) usageError(`${command} requires --input FILE or --input - for stdin.`);
  for (const key of ["limit", "offset"]) {
    if (options[key] === undefined) continue;
    if (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) usageError(`--${key} must be an integer.`);
    options[key] = Number(options[key]);
    if (key === "limit" && (options[key] < 1 || options[key] > (command === "search" ? 20 : 20000))) {
      usageError(`--limit must be between 1 and ${command === "search" ? 20 : 20000}.`);
    }
  }
  if (options["request-id"] && options["request-id"].length > 200) usageError("--request-id must be at most 200 characters.");
  return { command, options, space, operand: positional[0], writing };
}

async function inputJSON(filename, command) {
  if (filename === "-" && process.stdin.isTTY) usageError("Pipe JSON to stdin when using --input -.");
  const raw = filename === "-" ? await Bun.stdin.text() : await readFile(filename, "utf8");
  if (raw.length > 100000) usageError("JSON input must be at most 100000 characters.");
  let input;
  try { input = JSON.parse(raw); } catch { usageError("Input must be valid JSON."); }
  if (!input || typeof input !== "object" || Array.isArray(input)) usageError("Input must be a JSON object.");
  const required = command === "record" ? ["topic", "goal", "conclusion", "details"] : ["content", "expectedRevision"];
  const fields = command === "record" ? [...required, "decisions", "nextSteps", "preferences"] : required;
  for (const [key, value] of Object.entries(input)) {
    if (!fields.includes(key)) usageError(`Unknown input field: ${key}. Select memory space with --space.`);
    if (typeof value !== "string") usageError(`${key} must be a string.`);
  }
  for (const key of required) if (!input[key]?.trim()) usageError(`${key} must be a non-empty string.`);
  if (command === "record" && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.topic) || input.topic.length > 80)) {
    usageError("topic must be an English/pinyin slug of at most 80 characters.");
  }
  return input;
}

export async function run(args, env = process.env) {
  const parsed = parse(args);
  if (parsed.help) return { help };
  const { command, options, space, operand, writing } = parsed;
  const root = path.resolve(options.root ?? env.MEMORY_ROOT ?? process.cwd());
  if (!(await stat(root)).isDirectory()) usageError("--root must refer to an existing directory.");
  const store = new MemoryStore(root);
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
  for (const key of ["limit", "offset"]) if (options[key] !== undefined) input[key] = options[key];
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
