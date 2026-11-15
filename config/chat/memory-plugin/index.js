import path from "node:path";
import { MemoryStore } from "./store.js";

const scope = { type: "string", enum: ["default", "shared", "private", "both"], default: "default" };
const text = { type: "string" };
const definitions = [
  ["recall", "Start-of-session memory review: long-term memory and five recent index entries. serious/build/plan get shared memory only; plan is read-only; casual gets both spaces. Truncated memory can be paged with read.", {}, []],
  ["search", "Search memory using case-insensitive literal terms (all whitespace-separated terms must match). Returns bounded snippets and filenames; use read for details.",
    { query: text, scope, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]],
  ["read", "Read a memory filename returned by search/record, or MEMORY.md / INDEX.md. Metadata is separate from the Markdown body; offset/limit count body characters. INDEX.md is derived live from records. Returns a revision for safe long-term updates.",
    { name: text, scope, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20000 } }, ["name"]],
  ["record", "Save a concluded topic (or progress at a topic switch) and update its index in one call. Provide useful summary and detailed Markdown, not a transcript. Respect do-not-record requests. serious/build use shared only; casual defaults private and shared writes require an explicit user request and share=true. plan cannot record.",
    { topic: text, goal: text, conclusion: text, details: text, decisions: text, nextSteps: text, preferences: text,
      scope, share: { type: "boolean", default: false } }, ["topic", "goal", "conclusion", "details"]],
  ["update", "Update the Markdown body of MEMORY.md; YAML metadata and stable ID are preserved automatically. Read the complete body first, merge enduring facts/preferences, retain relevant content, and mark obsolete facts deprecated. Supply expectedRevision; stale revisions fail. Respect do-not-record requests. serious/build use shared only; casual defaults to private and explicit sharing requires share=true. plan cannot update.",
    { content: text, expectedRevision: text, scope, share: { type: "boolean", default: false } }, ["content", "expectedRevision"]],
];

// OpenCode 2.2.5 Plugin.define is an identity helper. Exporting its documented
// { id, setup } shape directly keeps this local plugin dependency-free.
export default {
  id: "workspace-memory",
  async setup(ctx) {
    const root = ctx.options.root ?? ctx.location.project.directory;
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Memory root must be an absolute directory.");
    const store = new MemoryStore(root);
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "memory", description: "Review, search, and maintain the chat workspace's Markdown memory." });
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
