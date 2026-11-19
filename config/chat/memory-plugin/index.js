import path from "node:path";
import { createMemoryStore } from "./backend.js";

const scope = { type: "string", enum: ["default", "shared", "private", "both"], default: "default" };
const text = { type: "string" };
const definitions = [
  ["recall", "Start-of-session review: summary/navigation, section titles, and five recent entries. Without a summary, bodies of at most 2000 characters are returned in full (mode=full); longer files report missing summaries (mode=overview). Use section reads for details. serious/build/plan shared only; casual both spaces.", {}, []],
  ["search", "Search memory using case-insensitive literal terms (all whitespace-separated terms must match). Returns bounded snippets and filenames; use read for details.",
    { query: text, scope, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]],
  ["read", "Read MEMORY.md or a session filename, optionally by exact section title (without #); missing/duplicate titles fail. Includes heading and nested sections until next same/higher heading. Pagination is section-relative; metadata/revision cover the full file. Read every selected-section page before section updates, or every whole-body page before whole-file updates. INDEX.md supports only whole-body pagination.",
    { name: text, scope, section: { type: "string", minLength: 1, description: "Exact heading title without # markers." }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20000 } }, ["name"]],
  ["record", "Save a concluded topic (or progress at a topic switch) and update its index in one call. Returns name and logicalPath, SQLite document identifiers; the Markdown body is stored in the database. Provide useful summary and detailed Markdown, not a transcript. Respect do-not-record requests. serious/build use shared only; casual defaults private and shared writes require an explicit user request and share=true. plan cannot record.",
    { topic: text, goal: text, conclusion: text, details: text, decisions: text, nextSteps: text, preferences: text,
      scope, share: { type: "boolean", default: false } }, ["topic", "goal", "conclusion", "details"]],
  ["update", "Update MEMORY.md, optionally replacing only an exact section. Read all pages of the selected section or full body first. Section content includes its unchanged heading title/level and nested sections; all other content is preserved. Metadata/ID are preserved; expectedRevision covers the full file and stale revisions fail. Keep summary/navigation consistent when details change. Respect recording consent. serious/build shared only; casual defaults private, shared requires explicit consent and share=true. plan cannot update.",
    { content: text, expectedRevision: text, section: { type: "string", description: "Optional exact heading title. Read all section pages first; content replaces only that section including nested sections and must retain its heading title/level. Other sections remain unchanged. Revision covers the full file." }, scope, share: { type: "boolean", default: false } }, ["content", "expectedRevision"]],
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
            const writing = name === "record" || name === "update";
            const spaces = store.scopes(context.agent, input.scope, writing, input.share === true);
            await ctx.permission.assert({
              sessionID: context.sessionID, agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
              action: `memory_${name}`, resources: spaces,
            });
            const result = await store[name](context.agent, input, `${context.sessionID}:${context.messageID}:${context.id}`);
            return { content: JSON.stringify(result) };
          },
        });
      }
    });
  },
};
