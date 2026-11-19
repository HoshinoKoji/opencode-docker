import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { stat } from "node:fs/promises";
import * as z from "zod/v4";
import { ExternalMemoryStore } from "./policy.js";
import { help, parseOptions } from "./options.js";

const text = z.string().min(1).max(100000).refine((value) => !!value.trim(), "Must be non-empty.");
const scope = z.enum(["shared", "private", "both"]).optional();
const schemas = {
  recall: z.strictObject({ scope }),
  search: z.strictObject({ scope, query: z.string().min(1).max(500), limit: z.int().min(1).max(20).optional() }),
  read: z.strictObject({ scope, name: z.string().regex(/^(?:MEMORY|INDEX)\.md$|^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/), section: z.string().min(1).describe("Exact heading title without # markers; unsupported for INDEX.md.").optional(), offset: z.int().min(0).optional(), limit: z.int().min(1).max(20000).optional() }),
  record: z.strictObject({
    scope, requestId: z.string().min(1).max(200).refine((value) => !!value.trim()),
    topic: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    goal: text, conclusion: text, details: text,
    decisions: z.string().max(100000).optional(), nextSteps: z.string().max(100000).optional(), preferences: z.string().max(100000).optional(),
  }),
  update: z.strictObject({ scope, section: z.string().min(1).optional(), content: text, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }),
};
const descriptions = {
  recall: "Review summary/navigation, section titles and five recent records. Unsummarized bodies up to 2000 characters return in full (mode=full); longer files report missing summaries (mode=overview). Use memory_read with section for details.",
  search: "Search literal whitespace-separated terms; returns match count and up to 20 matches.",
  read: "Read a returned filename or MEMORY.md, optionally by exact section title; missing/ambiguous titles fail. Includes heading and nested sections. Pagination is section-relative; metadata/revision cover the full file. Read all selected pages before section update, or all whole-body pages before full update. INDEX.md supports only whole-body pagination.",
  record: "Save a topic and rebuild its index. Returns name and logicalPath, logical SQLite document identifiers; the Markdown body is stored in the database. Supply a unique requestId; reuse the same ID and content on retries, including after a lost response.",
  update: "Update long-term memory, optionally only section (exact heading title). Read all selected-section or full-body pages first. Section content must include the original heading title/level and may contain lower-level nested headings. Other sections and metadata are preserved. expectedRevision covers the full file; on conflict read again and merge. Keep summary/navigation consistent with detail changes.",
};

export function createServer(options) {
  const store = new ExternalMemoryStore(options.root, options);
  const server = new McpServer({ name: "workspace-memory", version: "1.0.0" }, {
    instructions: `Memory policy: ${options.space ?? "shared"}; ${options.readOnly ? "read-only" : "writes enabled"}. External clients are not authenticated as harness agents. Respect harness memory permissions, plan/temp modes, and user recording consent. With both spaces enabled, specify one scope for every write.`,
  });
  for (const [operation, inputSchema] of Object.entries(schemas)) {
    const writing = operation === "record" || operation === "update";
    if (writing && options.readOnly) continue;
    server.registerTool(`memory_${operation}`, {
      description: descriptions[operation], inputSchema,
      annotations: { readOnlyHint: !writing, destructiveHint: operation === "update", openWorldHint: false },
    }, async (args) => {
      try {
        // Enforced independently of discovery and schema validation.
        store.scopes(null, args.scope, writing);
        const { requestId, ...input } = args;
        const result = operation === "record"
          ? { ...await store.record(null, input, `mcp:${requestId}`), requestId }
          : await store[operation](null, input);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    });
  }
  return server;
}

if (import.meta.main) {
  let options;
  try { options = parseOptions(process.argv.slice(2)); }
  catch (error) { console.error(`memory-mcp: ${error.message}`); process.exit(2); }
  if (options.help) { console.error(help); process.exit(0); }
  try {
    if (!(await stat(options.root)).isDirectory()) throw new Error("Memory root must be an existing directory.");
    const handle = serveStdio(() => createServer(options));
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void handle.close(); });
  } catch (error) { console.error(`memory-mcp: ${error.message}`); process.exitCode = 1; }
}
