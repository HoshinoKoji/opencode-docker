import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decode, encode, legacyMetadata, oneLine } from "./format.js";
import { descriptor, overview, sections, replaceSection } from "./sections.js";

const revision = (text) => createHash("sha256").update(text).digest("hex");
const roots = { shared: ".sessions", private: ".sessions/casual" };
const limitText = (text, limit) => ({ text: text.slice(0, limit), truncated: text.length > limit });

export class MemoryStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  scopes(agent, scope = "default", writing = false, share = false) {
    if (!["serious", "casual", "build", "plan"].includes(agent)) {
      throw new Error("Memory tools are available only to serious, casual, build, and plan.");
    }
    if (agent === "plan" && writing) throw new Error("plan uses read-only shared memory.");
    if (scope === "default") scope = agent === "casual" ? (writing ? "private" : "both") : "shared";
    if (!["shared", "private", "both"].includes(scope)) throw new Error("Invalid memory scope.");
    if (scope === "both" && writing) throw new Error("Write to one memory space at a time.");
    if (agent !== "casual" && scope !== "shared") throw new Error(`${agent} uses shared memory only.`);
    if (writing && agent === "casual" && scope === "shared" && !share) {
      throw new Error("Shared writes from casual require share=true and an explicit user request to share.");
    }
    return scope === "both" ? ["shared", "private"] : [scope];
  }

  relative(scope, name) {
    if (!(scope in roots)) throw new Error("Invalid memory scope.");
    if (name === "MEMORY.md") return path.join(roots[scope], name);
    if (name !== "INDEX.md" && !/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)) {
      throw new Error("Use a memory filename returned by recall/search/record, without directories.");
    }
    return path.join(scope === "shared" ? ".sessions" : roots.private, name);
  }

  // Refuse symlinks instead of following memory paths into another location.
  async checked(relative) {
    let current = this.root;
    for (const segment of relative.split(path.sep)) {
      if (!segment) continue;
      current = path.join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`Memory symlinks are unsupported: ${relative}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return current;
  }

  async text(relative) {
    try {
      return await readFile(await this.checked(relative), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }

  // Resolve physical source paths separately so backup manifests remain restorable.
  async source(scope, name) {
    const canonical = this.relative(scope, name);
    if (scope !== "shared" || name !== "MEMORY.md") return canonical;
    const exists = async (relative) => {
      try {
        const info = await lstat(await this.checked(relative));
        if (!info.isFile()) throw new Error(`Memory path must be a regular file: ${relative}`);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    };
    const current = await exists(canonical);
    const legacy = await exists("MEMORY.md");
    if (current && legacy) throw new Error("Shared memory conflict: both MEMORY.md and .sessions/MEMORY.md exist. Back up and reconcile them before retrying (including empty placeholders).");
    return legacy ? "MEMORY.md" : canonical;
  }

  // Caller holds locked(), except for the strictly read-only preview.
  async relocateShared({ dryRun = false } = {}) {
    const source = await this.source("shared", "MEMORY.md");
    const target = this.relative("shared", "MEMORY.md");
    const report = { source, target, moved: false, dryRun, backup: null };
    if (source === target) return report;
    const originalPath = await this.checked(source);
    const original = await readFile(originalPath);
    const sha256 = revision(original);
    if (dryRun) return { ...report, wouldMove: true, sha256 };
    const batch = `relocate-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const directory = path.join(".sessions", ".backups", batch);
    const absolute = await this.checked(directory);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const backup = path.join(directory, "MEMORY.md");
    await writeFile(await this.checked(backup), original, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(absolute, "manifest.json"), JSON.stringify({
      schema_version: 1, scope: "shared", operation: "relocate-shared", target,
      files: [{ backup: "MEMORY.md", path: source, sha256 }],
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const verify = async (filename) => {
      if (!(await readFile(filename)).equals(original)) throw new Error(`File changed during shared relocation: ${filename}. Original backup: ${backup}`);
    };
    await verify(await this.checked(backup));
    await verify(originalPath);
    // Exclusive creation protects even against a destination appearing after preflight.
    const destination = await this.checked(target);
    await copyFile(await this.checked(backup), destination, constants.COPYFILE_EXCL);
    await verify(destination);
    await verify(originalPath);
    await unlink(originalPath);
    return { ...report, moved: true, backup, sha256 };
  }

  async atomic(relative, text) {
    const filename = await this.checked(relative);
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async locked(fn) {
    const directory = await this.checked(".sessions");
    await mkdir(directory, { recursive: true });
    const lock = path.join(directory, ".memory-lock");
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (attempt >= 100) throw new Error("Memory is busy (.sessions/.memory-lock). Retry; after a crashed writer, remove the lock only once no writer is running.");
        await delay(20);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { recursive: true });
    }
  }

  async recall(agent, { scope: requestedScope = "default" } = {}) {
    const spaces = [];
    for (const scope of this.scopes(agent, requestedScope)) {
      const text = await this.text(await this.source(scope, "MEMORY.md"));
      const document = decode(text);
      const entries = await this.entries(scope);
      spaces.push({
        scope,
        memory: { name: "MEMORY.md", metadata: document.metadata, revision: revision(text), ...overview(document.body) },
        recent: entries.slice(0, 5).map((entry) => this.indexLine(entry)),
      });
    }
    return { spaces };
  }

  async names(scope) {
    const directory = path.dirname(await this.checked(this.relative(scope, "INDEX.md")));
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return ["MEMORY.md", ...entries.filter((entry) => entry.isFile() &&
      /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(entry.name)).map((entry) => entry.name).sort().reverse()];
  }

  async entries(scope) {
    const entries = [];
    const ids = new Set();
    for (const name of (await this.names(scope)).filter((name) => name !== "MEMORY.md")) {
      const raw = await this.text(this.relative(scope, name));
      if (!raw) continue;
      const document = decode(raw);
      const metadata = document.metadata ?? legacyMetadata(scope, name, document.body);
      if (metadata.type !== "session") throw new Error(`Expected session metadata in ${name}.`);
      if (ids.has(metadata.id)) throw new Error(`Duplicate memory ID in ${scope}: ${metadata.id}. Resolve the synced file conflict first.`);
      ids.add(metadata.id);
      entries.push({ name, metadata });
    }
    return entries.sort((a, b) => b.metadata.date.localeCompare(a.metadata.date) ||
      b.metadata.created_at.localeCompare(a.metadata.created_at) || b.name.localeCompare(a.name));
  }

  indexLine({ name, metadata }) {
    return `${metadata.date} | ${name.slice(11, -3)} | ${oneLine(metadata.summary)} | ${oneLine(metadata.preferences)}`;
  }

  async indexText(scope) {
    const entries = await this.entries(scope);
    return `# Memory index\n\n<!-- Generated from record metadata; edit the records, then rebuild. -->\n\n${entries.map((entry) => this.indexLine(entry)).join("\n")}\n`;
  }

  // Call under locked() when persisting; reads render the same index on demand.
  async rebuild(scope) {
    const content = await this.indexText(scope);
    const relative = this.relative(scope, "INDEX.md");
    if (await this.text(relative) !== content) await this.atomic(relative, content);
    return relative;
  }

  async search(agent, { query, scope = "default", limit = 8 }) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || query.length > 500) throw new Error("Provide a non-empty query of at most 500 characters.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be between 1 and 20.");
    const results = [];
    for (const space of this.scopes(agent, scope)) {
      for (const name of await this.names(space)) {
        const raw = await this.text(await this.source(space, name));
        const document = decode(raw);
        const text = `${document.metadata ? `${document.metadata.topic}\n${document.metadata.summary}\n` : ""}${document.body}`;
        const lower = text.toLocaleLowerCase();
        if (!terms.every((term) => lower.includes(term))) continue;
        const first = Math.min(...terms.map((term) => lower.indexOf(term)));
        const start = Math.max(0, first - 120);
        results.push({ scope: space, name, metadata: document.metadata, snippet: text.slice(start, start + 700) });
      }
    }
    return { matches: results.length, results: results.slice(0, limit) };
  }

  async read(agent, { name, scope = "default", section, offset = 0, limit = 12000 }) {
    const spaces = this.scopes(agent, scope);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20000) {
      throw new Error("offset must be nonnegative; limit must be between 1 and 20000.");
    }
    const results = [];
    if (section !== undefined && (typeof section !== "string" || !section.trim())) throw new Error("section must be a non-empty exact heading title (without # markers).");
    if (section !== undefined && name === "INDEX.md") throw new Error("Section selection is unsupported for INDEX.md; use offset/limit.");
    for (const space of spaces) {
      const raw = name === "INDEX.md" ? await this.indexText(space) : await this.text(await this.source(space, name));
      const document = decode(raw);
      let body = document.body;
      let selected;
      if (section !== undefined) {
        const matches = sections(body).filter(({ title }) => title === section);
        if (!matches.length) throw new Error(`Section not found: ${section} in ${space}/${name}.`);
        if (matches.length > 1) throw new Error(`Ambiguous section: ${section} in ${space}/${name}; use whole-file read.`);
        selected = descriptor(matches[0]);
        body = body.slice(matches[0].start, matches[0].end);
      }
      results.push({ scope: space, name, metadata: document.metadata, revision: revision(raw), offset,
        ...(selected ? { section: selected, guidance: "Read all selected-section pages before updating with section and the original heading included. For whole-file updates omit section and read all body pages. Revision covers the full file." } : {}),
        ...limitText(body.slice(offset), limit), total: body.length });
    }
    return { results };
  }

  async record(agent, input, callKey) {
    const [scope] = this.scopes(agent, input.scope, true, input.share === true);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.topic) || input.topic.length > 80) {
      throw new Error("topic must be a short English/pinyin slug, at most 80 characters.");
    }
    for (const key of ["goal", "conclusion", "details"]) {
      if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`${key} must be non-empty.`);
    }
    if (JSON.stringify(input).length > 100000) throw new Error("Record is too large; keep it under 100000 characters.");
    const now = new Date().toISOString();
    const date = now.slice(0, 10);
    // A stable call suffix makes retries idempotent and avoids same-day clashes.
    const topic = `${input.topic}-${revision(callKey).slice(0, 12)}`;
    const name = `${date}-${topic}.md`;
    const body = [`# ${input.topic}`, `## Goal\n${input.goal.trim()}`, `## Details\n${input.details.trim()}`,
      input.decisions && `## Decisions\n${input.decisions.trim()}`,
      input.nextSteps && `## Next steps\n${input.nextSteps.trim()}`].filter(Boolean).join("\n\n") + "\n";
    const metadata = {
      schema_version: 1, id: `record-${revision(`${scope}:${callKey}:${input.topic}`).slice(0, 32)}`,
      type: "session", date, topic: input.topic, summary: input.conclusion.trim(),
      created_at: now, updated_at: now,
      ...(input.preferences ? { preferences: input.preferences.trim() } : {}),
    };
    return this.locked(async () => {
      // Find a previous call by its stable ID, including retries on a later UTC
      // day or after a file rename. Reuse its original filename and timestamps.
      const prior = (await this.entries(scope)).find((entry) => entry.metadata.id === metadata.id);
      const savedName = prior?.name ?? name;
      const relative = this.relative(scope, savedName);
      const existing = await this.text(relative);
      const previous = decode(existing);
      // Reuse timestamps on an identical retry; preserve additional metadata.
      const content = encode({ ...metadata, ...previous.metadata }, body);
      if (existing && (previous.body !== body || previous.metadata?.summary !== metadata.summary ||
          (previous.metadata?.preferences ?? "") !== (metadata.preferences ?? ""))) {
        throw new Error("This call already saved different content; read the existing record before retrying.");
      }
      if (!existing) await this.atomic(relative, content);
      await this.rebuild(scope);
      return { scope, name: savedName, path: relative, id: previous.metadata?.id ?? metadata.id, revision: revision(existing || content) };
    }, scope);
  }

  async update(agent, { content, expectedRevision, section, scope = "default", share = false }) {
    const [space] = this.scopes(agent, scope, true, share === true);
    if (typeof content !== "string" || !content.trim() || content.length > 100000) {
      throw new Error("Long-term memory must be non-empty and at most 100000 characters.");
    }
    return this.locked(async () => {
      const relative = this.relative(space, "MEMORY.md");
      const previous = await this.text(await this.source(space, "MEMORY.md"));
      if (revision(previous) !== expectedRevision) throw new Error("Memory changed since it was read. Read MEMORY.md again and merge your changes.");
      const document = decode(previous);
      if (decode(content).metadata) throw new Error("Pass only the Markdown body to update; the plugin preserves metadata automatically.");
      const now = new Date().toISOString();
      const metadata = await this.updateMetadata(space, document, now);
      if (metadata.type !== "long_term") throw new Error("MEMORY.md must have long_term metadata.");
      const body = section === undefined ? `${content.trim()}\n` : replaceSection(document.body, section, content);
      if (body.length > 100000) throw new Error("Long-term memory must be at most 100000 characters.");
      const text = encode({ ...metadata, updated_at: now }, body);
      if (space === "shared") await this.relocateShared();
      await this.atomic(relative, text);
      return { scope: space, name: "MEMORY.md", ...(section === undefined ? {} : { section }), revision: revision(text) };
    }, space);
  }

  async updateMetadata(_scope, document, now) {
    return document.metadata ?? {
      schema_version: 1, id: `memory-${randomUUID()}`, type: "long_term", date: now.slice(0, 10),
      topic: "long-term-memory", summary: "Long-term preferences and context", created_at: now,
    };
  }
}
