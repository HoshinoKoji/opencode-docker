import path from "node:path";
import { createMemoryStore } from "./backend.js";
import { SESSION_FILENAME } from "./format.js";

const scope = { type: "string", enum: ["default", "shared", "private", "both"], default: "default" };
const writeScope = { scope, share: { type: "boolean", default: false } };
const text = { type: "string" };
const expectedRevision = { type: "string", pattern: "^[a-f0-9]{64}$", description: "Full document revision returned by read." };
const definitions = [
  ["recall", "Start-of-session review: summary/navigation, section titles, and five recent entries. Without a summary, bodies of at most 2000 characters are returned in full (mode=full); longer files report missing summaries (mode=overview). Use section reads for details. serious/build/plan shared only; casual both spaces.", {}, []],
  ["search", "Search memory using case-insensitive literal terms (all whitespace-separated terms must match). Returns bounded snippets and filenames; use read for details.",
    { query: text, scope, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]],
  ["read", "Read MEMORY.md or a session filename, optionally by exact section title (without #); missing/duplicate titles fail. Includes heading and nested sections until next same/higher heading. Pagination is section-relative; metadata/revision cover the full file. Read every selected-section page before section updates, or every whole-body page before whole-file updates. INDEX.md supports only whole-body pagination.",
    { name: text, scope, section: { type: "string", minLength: 1, description: "Exact heading title without # markers." }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20000 } }, ["name"]],
  ["record", "Save a concluded topic (or progress at a topic switch) and update its index in one call. Returns name and logicalPath, SQLite document identifiers; the Markdown body is stored in the database. Provide useful summary and detailed Markdown, not a transcript. Respect do-not-record requests. serious/build use shared only; casual defaults private and shared writes require an explicit user request and share=true. plan cannot record.",
    { topic: text, goal: text, conclusion: text, details: text, decisions: text, nextSteps: text, preferences: text,
      ...writeScope }, ["topic", "goal", "conclusion", "details"]],
  ["update", "Update the Markdown body of MEMORY.md (default) or an existing session record. Read all pages of the selected section or full body first. Section content includes its unchanged heading title/level and nested sections; the rest of the body stays unchanged. Metadata, including the stored summary, is preserved except updated_at. Stale revisions fail. Respect recording consent. serious/build shared only; casual defaults private, shared requires explicit consent and share=true. plan cannot update.",
    { name: { type: "string", pattern: `^MEMORY\\.md$|${SESSION_FILENAME.source}` }, content: text, expectedRevision, section: { type: "string", description: "Optional exact heading title. Read all section pages first; content replaces only that section including nested sections and must retain its heading title/level. Other sections remain unchanged. Revision covers the full file." }, ...writeScope }, ["content", "expectedRevision"]],
  ["delete", "Delete one existing session record only at the user's explicit request. Read it first to get its exact name and current revision. Requires SQLite v2; deletion retains history and removes the record from normal reads, search, recall, index and export. serious/build shared only; casual defaults private, shared requires explicit consent and share=true. plan cannot delete.",
    { name: { type: "string", pattern: SESSION_FILENAME.source }, expectedRevision, ...writeScope }, ["name", "expectedRevision"]],
];

// OpenCode 2.2.5 Plugin.define is an identity helper. Exporting its documented
// { id, setup } shape directly keeps this local plugin dependency-free.
export default {
  id: "workspace-memory",
  async setup(ctx) {
    const backend = ctx.options.backend ?? process.env.MEMORY_BACKEND ?? "sqlite";
    const root = ctx.options.root ?? process.env.MEMORY_ROOT;
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Memory root must be an absolute directory.");
    const store = createMemoryStore(root, { backend });
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "memory", description: "Review, search, and maintain workspace memory." });
      for (const [name, description, properties, required] of definitions) {
        editor.add({
          name, description,
          input: { type: "object", properties, required, additionalProperties: false },
          options: { namespace: "memory", codemode: true },
          execute: async (input, context) => {
            const writing = name === "record" || name === "update" || name === "delete";
            const spaces = store.scopes(context.agent, input.scope, writing, input.share === true);
            if (name === "update" || name === "delete") {
              for (const key of Object.keys(input)) if (!Object.hasOwn(properties, key)) throw new Error(`Unknown input field: ${key}.`);
            }
            await ctx.permission.assert({
              sessionID: context.sessionID, agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
              action: `memory_${name}`, resources: spaces,
              ...(name === "delete" ? { metadata: { name: input.name } } : {}),
            });
            const result = await store[name](context.agent, input, `${context.sessionID}:${context.messageID}:${context.id}`);
            return { content: JSON.stringify(result) };
          },
        });
      }
    });
  },
};
