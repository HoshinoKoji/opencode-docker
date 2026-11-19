import { createHash } from "node:crypto";

export const digest = (text) => createHash("sha256").update(text).digest("hex");
export const oneLine = (text = "") => text.replace(/[\r\n|]+/g, " ").trim();
export const SESSION_FILENAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

export function decode(text) {
  if (!/^(?:\uFEFF)?---\r?\n/.test(text)) return { metadata: null, body: text };
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Unclosed YAML frontmatter; fix the file before continuing.");
  const metadata = Bun.YAML.parse(match[1]);
  validate(metadata);
  return { metadata, body: text.slice(match[0].length) };
}

function validate(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Frontmatter must be a YAML mapping.");
  if (metadata.schema_version !== 1) throw new Error("Unsupported memory schema_version (expected 1).");
  if (!["session", "long_term"].includes(metadata.type)) throw new Error("Invalid memory type.");
  for (const key of ["id", "topic", "summary", "date", "created_at", "updated_at"]) {
    if (typeof metadata[key] !== "string" || !metadata[key].trim()) throw new Error(`Frontmatter ${key} must be a non-empty string.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(metadata.date) ||
      !Number.isFinite(Date.parse(metadata.date)) || new Date(metadata.date).toISOString().slice(0, 10) !== metadata.date) {
    throw new Error("Invalid frontmatter date.");
  }
  for (const key of ["created_at", "updated_at"]) {
    if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(metadata[key]) || !Number.isFinite(Date.parse(metadata[key]))) {
      throw new Error(`Frontmatter ${key} must be a UTC ISO timestamp.`);
    }
  }
  if (metadata.preferences !== undefined && typeof metadata.preferences !== "string") throw new Error("preferences must be a string.");
}

export function encode(metadata, body) {
  validate(metadata);
  // JSON-quoted YAML scalars also safely represent colons, hashes, multiline
  // values, Unicode, and dates. Unknown metadata is retained as YAML flow data.
  const header = Object.entries(metadata).map(([key, value]) =>
    `${/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(value)}`).join("\n");
  return `---\n${header}\n---\n${body}`;
}

export function legacyMetadata(scope, name, body, modifiedAt = "1970-01-01T00:00:00.000Z") {
  const session = name !== "MEMORY.md";
  const date = session ? name.slice(0, 10) : modifiedAt.slice(0, 10);
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const field = (labels) => new RegExp(`^- (?:${labels})[：:][ \\t]*([^\\r\\n]*)`, "m").exec(body)?.[1]?.trim();
  const timestamp = session ? `${date}T00:00:00.000Z` : modifiedAt;
  return {
    schema_version: 1,
    id: `legacy-${digest(`${scope}:${name}`).slice(0, 32)}`,
    type: session ? "session" : "long_term",
    date,
    topic: session ? name.slice(11, -3) : "long-term-memory",
    summary: session ? field("Conclusion / deliverables|结论 / 产出") || title || name.slice(11, -3) : "Long-term preferences and context",
    created_at: timestamp,
    updated_at: timestamp,
    timestamp_source: session ? "legacy-date" : "legacy-file-mtime",
    ...(title ? { title } : {}),
    ...(field("Preferences / context|偏好 / 上下文") ? { preferences: field("Preferences / context|偏好 / 上下文") } : {}),
  };
}
