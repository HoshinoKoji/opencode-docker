import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin from "../config/chat/memory-plugin/index.js";
import { MemoryStore } from "../config/chat/memory-plugin/store.js";
import { decode, encode } from "../config/chat/memory-plugin/format.js";
import { migrate, relocateShared } from "../config/chat/memory-plugin/manage.js";
import { sections } from "../config/chat/memory-plugin/sections.js";
import { createMemoryStore } from "../config/chat/memory-plugin/backend.js";

const directories = [];
test("section updates preserve surrounding bytes, metadata and reject unsafe replacements", async () => {
  const { root, store } = await fixture();
  const body = "# Memory\nintro\n\n## First\nold\n### Child\nnested\n\n## Last\nkeep exactly\n";
  const empty = (await store.read("serious", { name: "MEMORY.md" })).results[0];
  await store.update("serious", { content: body, expectedRevision: empty.revision });
  const before = (await store.read("serious", { name: "MEMORY.md", section: "First" })).results[0];
  for (const [section, content] of [["Missing", "## Missing\nx"], ["First", "## Renamed\nx"], ["First", "# First\nx"], ["First", "## First\nx\n## Other\ny"], ["First", "## First\n```js\nx"]]) {
    await expect(store.update("serious", { section, content, expectedRevision: before.revision })).rejects.toThrow();
    expect((await store.read("serious", { name: "MEMORY.md" })).results[0].revision).toBe(before.revision);
  }
  await store.update("serious", { section: "First", content: "## First\nnew\n### Child\nchanged", expectedRevision: before.revision });
  const after = (await store.read("serious", { name: "MEMORY.md" })).results[0];
  expect(after.text).toBe("# Memory\nintro\n\n## First\nnew\n### Child\nchanged\n\n## Last\nkeep exactly\n");
  expect(after.metadata.id).toBe(before.metadata.id);
  expect(after.metadata.created_at).toBe(before.metadata.created_at);
  await expect(store.update("serious", { section: "First", content: "## First\nstale", expectedRevision: before.revision })).rejects.toThrow("Memory changed");
  await expect(store.update("plan", { section: "First", content: "## First\nx", expectedRevision: after.revision })).rejects.toThrow("read-only");
  await writeFile(path.join(root, ".sessions/MEMORY.md"), "## Same\na\n## Same\nb\n");
  const duplicate = (await store.read("serious", { name: "MEMORY.md" })).results[0];
  await expect(store.update("serious", { section: "Same", content: "## Same\nx", expectedRevision: duplicate.revision })).rejects.toThrow("Ambiguous");
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-memory-test-"));
  directories.push(root);
  return { root, store: new MemoryStore(root) };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const input = {
  topic: "container-memory", goal: "Reduce tool calls", conclusion: "Keep Markdown files",
  details: "Discussed a plugin and retained readable files.\n\nNext: verify the integration.",
};

test("ATX parser handles CRLF, fence lengths, closing hashes and level boundaries", () => {
  const body = "   ## Parent ###\r\ntext\r\n````md\r\n## hidden\r\n```\r\n## still hidden\r\n````\r\n### Child\r\n###### Deep\r\n####### not ATX\r\n    ## indented code\r\n# End\r\n";
  const parsed = sections(body);
  expect(parsed.map(({ title, level }) => ({ title, level }))).toEqual([
    { title: "Parent", level: 2 }, { title: "Child", level: 3 },
    { title: "Deep", level: 6 }, { title: "End", level: 1 },
  ]);
  expect(parsed[0].end).toBe(body.indexOf("# End"));
  expect(parsed[1].end).toBe(parsed[0].end);
});

test("progressive recall exposes summaries/navigation, and section reads preserve full revisions", async () => {
  const { root, store } = await fixture();
  const body = "# 日常模式长期记忆\n## 速览摘要\nCompact summary\n## 内部导航与按需提取索引\nSee preferences\n## 交流风格与记忆维护偏好\nDETAIL-ONLY\n### Nested\nchild\n```md\n## Fake\n```\n~~~\n## Also fake\n~~~\n## Other\nexcluded\n";
  const initial = (await store.read("build", { name: "MEMORY.md" })).results[0];
  await store.update("build", { content: body, expectedRevision: initial.revision });
  const whole = (await store.read("build", { name: "MEMORY.md" })).results[0];
  const memory = (await store.recall("build")).spaces[0].memory;
  expect(memory.text).toContain("Compact summary");
  expect(memory.text).toContain("See preferences");
  expect(memory.text).not.toContain("DETAIL-ONLY");
  expect(memory.summaryFound).toBe(true);
  expect(memory.sections.some((s) => s.title === "Fake")).toBe(false);
  const args = { name: "MEMORY.md", section: "交流风格与记忆维护偏好" };
  const selected = (await store.read("build", args)).results[0];
  expect(selected.text).toContain("### Nested\nchild");
  expect(selected.text).not.toContain("excluded");
  expect(selected.revision).toBe(whole.revision);
  expect(selected.metadata).toEqual(whole.metadata);
  const page = (await store.read("build", { ...args, offset: 7, limit: 11 })).results[0];
  expect(page.text).toBe(selected.text.slice(7, 18));
  expect(page.total).toBe(selected.text.length);
  expect(page.truncated).toBe(true);
  expect((await store.read("build", { ...args, offset: selected.total })).results[0].text).toBe("");
  await expect(store.read("build", { ...args, section: "Fake" })).rejects.toThrow("Section not found");
  await expect(store.read("build", { name: "INDEX.md", section: "Memory index" })).rejects.toThrow("unsupported");
  await store.update("build", { content: body + "## Other\nduplicate\n", expectedRevision: whole.revision });
  await expect(store.read("build", { ...args, section: "Other" })).rejects.toThrow("Ambiguous section");
  await expect(store.update("build", { content: body, expectedRevision: selected.revision })).rejects.toThrow("Memory changed");
});

test("recall returns short unsummarized files in full but never excerpts long details", async () => {
  const { root, store } = await fixture();
  for (const body of ["short lasting preference", "x".repeat(2000), "x".repeat(2001), "# Memory\n## Details\n" + "SECRET".repeat(3000), "## 内部索引\nFind details\n## Details\nSECRET"]) {
    await writeFile(path.join(root, "MEMORY.md"), body);
    const memory = (await store.recall("build")).spaces[0].memory;
    expect(memory.summaryFound).toBe(false);
    expect(memory.mode).toBe(body.length <= 2000 ? "full" : "overview");
    if (body.length <= 2000) {
      expect(memory.text).toBe(body);
      expect(memory.total).toBe(body.length);
      expect(memory.truncated).toBe(false);
    } else {
      expect(memory.guidance).toContain("Summary missing");
      expect(memory.text).not.toContain("SECRET");
      expect(memory.text).toBe("");
    }
    expect(memory.guidance).toContain("Read MEMORY.md");
  }
  await writeFile(path.join(root, "MEMORY.md"), "## Summary\n" + "x".repeat(12000) + "\n## Navigation\nlinks\n" + Array.from({ length: 110 }, (_, i) => `## Detail ${i}\nsecret\n`).join(""));
  const memory = (await store.recall("build")).spaces[0].memory;
  expect(memory.text).toHaveLength(10000);
  expect(memory.truncated).toBe(true);
  expect(memory.sections).toHaveLength(100);
  expect(memory.sectionsTruncated).toBe(true);
  expect((await store.read("build", { name: "MEMORY.md", section: "Navigation" })).results[0].text).toBe("## Navigation\nlinks\n");
});

test("reviewing an empty workspace has no filesystem side effects", async () => {
  const { root, store } = await fixture();
  const result = await store.recall("serious");
  expect(result.spaces[0].memory.text).toBe("");
  expect(result.spaces[0].recent).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});

test("shared relocation previews without side effects and preserves bytes, IDs and revisions", async () => {
  const { root, store } = await fixture();
  const original = encode({ schema_version: 1, id: "stable-memory", type: "long_term",
    date: "2000-01-01", topic: "preferences", summary: "Original", created_at: "2000-01-01T00:00:00Z",
    updated_at: "2000-01-01T00:00:00Z", custom: ["keep"] }, "# Memory\r\n中文 marker\r\n");
  await writeFile(path.join(root, "MEMORY.md"), original);
  const before = (await store.read("build", { name: "MEMORY.md" })).results[0];
  expect((await store.recall("plan")).spaces[0].memory.revision).toBe(before.revision);
  expect((await store.search("build", { query: "marker" })).matches).toBe(1);
  expect((await relocateShared(root, { dryRun: true })).wouldMove).toBe(true);
  expect(await readdir(root)).toEqual(["MEMORY.md"]);
  const moved = await relocateShared(root);
  expect(moved.moved).toBe(true);
  expect(moved.sha256).toBe(before.revision);
  expect(await readFile(path.join(root, moved.backup))).toEqual(Buffer.from(original));
  expect(await readFile(path.join(root, moved.target))).toEqual(Buffer.from(original));
  expect(await readdir(root)).toEqual([".sessions"]);
  const manifest = JSON.parse(await readFile(path.join(root, path.dirname(moved.backup), "manifest.json"), "utf8"));
  expect(manifest.files).toEqual([{ backup: "MEMORY.md", path: "MEMORY.md", sha256: before.revision }]);
  expect((await store.read("build", { name: "MEMORY.md" })).results[0]).toEqual(before);
  expect(await store.names("shared")).toEqual(["MEMORY.md"]);
  expect(await store.entries("shared")).toEqual([]);
  expect((await relocateShared(root)).moved).toBe(false);
  expect(await readdir(path.join(root, ".sessions/.backups"))).toHaveLength(1);
});

test("legacy update validates revision before relocation, backs up, and retains metadata", async () => {
  const { root, store } = await fixture();
  await writeFile(path.join(root, "MEMORY.md"), "# Old\r\nmarker\r\n");
  await migrate(root, { scopes: ["shared"] });
  const original = await readFile(path.join(root, "MEMORY.md"), "utf8");
  const before = (await store.read("build", { name: "MEMORY.md" })).results[0];
  await expect(store.update("build", { content: "new", expectedRevision: "stale" })).rejects.toThrow("Memory changed");
  expect(await readFile(path.join(root, "MEMORY.md"), "utf8")).toBe(original);
  await store.update("build", { content: "# Updated", expectedRevision: before.revision });
  const after = (await store.read("build", { name: "MEMORY.md" })).results[0];
  expect(after.metadata.id).toBe(before.metadata.id);
  expect(after.metadata.created_at).toBe(before.metadata.created_at);
  const batch = (await readdir(path.join(root, ".sessions/.backups"))).find((name) => name.startsWith("relocate-"));
  expect(await readFile(path.join(root, ".sessions/.backups", batch, "MEMORY.md"), "utf8")).toBe(original);
  await expect(readFile(path.join(root, "MEMORY.md"))).rejects.toThrow();
});

test("dual shared paths conflict even when identical or empty, without overwriting either", async () => {
  const { root, store } = await fixture();
  await mkdir(path.join(root, ".sessions"));
  for (const canonical of ["# Other", "# Legacy", ""]) {
    await writeFile(path.join(root, "MEMORY.md"), "# Legacy");
    await writeFile(path.join(root, ".sessions/MEMORY.md"), canonical);
    await expect(store.recall("build")).rejects.toThrow("Shared memory conflict");
    await expect(store.search("build", { query: "Legacy" })).rejects.toThrow("Shared memory conflict");
    await expect(store.read("build", { name: "MEMORY.md" })).rejects.toThrow("Shared memory conflict");
    await expect(store.update("build", { content: "overwrite", expectedRevision: "anything" })).rejects.toThrow("Shared memory conflict");
    await expect(migrate(root, { scopes: ["shared"] })).rejects.toThrow("Shared memory conflict");
    await expect(relocateShared(root, { dryRun: true })).rejects.toThrow("Shared memory conflict");
    await expect(relocateShared(root)).rejects.toThrow("Shared memory conflict");
    expect(await readFile(path.join(root, "MEMORY.md"), "utf8")).toBe("# Legacy");
    expect(await readFile(path.join(root, ".sessions/MEMORY.md"), "utf8")).toBe(canonical);
    expect(await readdir(path.join(root, ".sessions"))).toEqual(["MEMORY.md"]);
  }
});

test("canonical metadata migration uses canonical manifest paths; relocation serializes", async () => {
  const { root, store } = await fixture();
  expect((await relocateShared(root, { dryRun: true })).moved).toBe(false);
  expect(await readdir(root)).toEqual([]);
  await writeFile(path.join(root, "MEMORY.md"), "# Legacy\r\n");
  const results = await Promise.all([relocateShared(root), relocateShared(root)]);
  expect(results.filter((result) => result.moved)).toHaveLength(1);
  const report = await migrate(root, { scopes: ["shared"] });
  const manifest = JSON.parse(await readFile(path.join(root, report.backups[0], "manifest.json"), "utf8"));
  expect(manifest.files[0].path).toBe(".sessions/MEMORY.md");
  expect(decode(await readFile(path.join(root, ".sessions/MEMORY.md"), "utf8")).body).toBe("# Legacy\r\n");
  expect((await migrate(root, { scopes: ["shared"] })).files).toBe(0);
  expect(await store.entries("shared")).toEqual([]);
});

test("relocation preserves source and backup if a destination appears after preflight", async () => {
  const { root, store } = await fixture();
  await writeFile(path.join(root, "MEMORY.md"), "original bytes\r\n");
  const checked = store.checked.bind(store);
  let checks = 0;
  store.checked = async (relative) => {
    const filename = await checked(relative);
    if (relative === ".sessions/MEMORY.md" && ++checks === 2) {
      await writeFile(filename, "external writer", { flag: "wx" });
    }
    return filename;
  };
  await expect(store.locked(() => store.relocateShared())).rejects.toThrow();
  expect(await readFile(path.join(root, "MEMORY.md"), "utf8")).toBe("original bytes\r\n");
  expect(await readFile(path.join(root, ".sessions/MEMORY.md"), "utf8")).toBe("external writer");
  const [batch] = await readdir(path.join(root, ".sessions/.backups"));
  expect(await readFile(path.join(root, ".sessions/.backups", batch, "MEMORY.md"), "utf8")).toBe("original bytes\r\n");
});

test("agent identity controls reads/writes, casual defaults private and explicit sharing works", async () => {
  const { store } = await fixture();
  await store.record("serious", input, "shared-call");
  await store.record("casual", { ...input, details: "Private marker" }, "private-call");
  expect((await store.search("serious", { query: "Private marker" })).matches).toBe(0);
  expect((await store.search("casual", { query: "Private marker" })).results[0].scope).toBe("private");
  expect((await store.recall("casual")).spaces.map((space) => space.scope)).toEqual(["shared", "private"]);
  await expect(store.search("serious", { query: "marker", scope: "private" })).rejects.toThrow("shared memory only");
  for (const agent of ["temp", "general", "explore", "unknown"]) {
    await expect(store.recall(agent)).rejects.toThrow("only to serious, casual, build, and plan");
    await expect(store.record(agent, input, "blocked")).rejects.toThrow();
  }
  await expect(store.record("casual", { ...input, scope: "shared" }, "share-call")).rejects.toThrow("share=true");
  expect((await store.record("casual", { ...input, scope: "shared", share: true }, "share-call")).scope).toBe("shared");
});

test("build writes shared memory and plan reads it, with private scopes and plan writes rejected", async () => {
  const { root, store } = await fixture();
  const record = await store.record("build", input, "build-record");
  expect(record.scope).toBe("shared");
  const initial = (await store.read("build", { name: "MEMORY.md" })).results[0];
  await store.update("build", { content: "# Shared context", expectedRevision: initial.revision });
  await store.record("casual", { ...input, details: "Private marker" }, "private-record");
  for (const agent of ["build", "plan"]) {
    expect((await store.recall(agent)).spaces.map((space) => space.scope)).toEqual(["shared"]);
    expect((await store.search(agent, { query: "Private marker" })).matches).toBe(0);
    expect((await store.read(agent, { name: record.name })).results[0].text).toContain(input.details);
    expect((await store.read(agent, { name: "MEMORY.md" })).results[0].text).toContain("Shared context");
    for (const scope of ["private", "both"]) {
      await expect(store.recall(agent, { scope })).rejects.toThrow("shared memory only");
      await expect(store.search(agent, { scope, query: "marker" })).rejects.toThrow("shared memory only");
      await expect(store.read(agent, { scope, name: "MEMORY.md" })).rejects.toThrow("shared memory only");
      await expect(store.record(agent, { ...input, scope, share: true }, "denied")).rejects.toThrow();
      await expect(store.update(agent, { scope, share: true, content: "denied", expectedRevision: initial.revision })).rejects.toThrow();
    }
  }
  const before = await readFile(path.join(root, ".sessions/MEMORY.md"), "utf8");
  const files = await readdir(path.join(root, ".sessions"));
  for (const scope of ["default", "shared", "private", "both"]) {
    await expect(store.record("plan", { ...input, scope, share: true }, "denied")).rejects.toThrow("read-only");
    await expect(store.update("plan", { scope, content: "denied", expectedRevision: initial.revision, share: true })).rejects.toThrow("read-only");
  }
  expect(await readFile(path.join(root, ".sessions/MEMORY.md"), "utf8")).toBe(before);
  expect(await readdir(path.join(root, ".sessions"))).toEqual(files);
});

test("concurrent records rebuild indexes including legacy files and retry without duplication", async () => {
  const { root, store } = await fixture();
  await mkdir(path.join(root, ".sessions"));
  const index = path.join(root, ".sessions/INDEX.md");
  await writeFile(index, "# History\n\n2000-01-01 | old | Existing conclusion | Existing preference\n");
  await writeFile(path.join(root, ".sessions/2000-01-01-old.md"), "# Old\n- Conclusion / deliverables: Existing conclusion\n- Preferences / context: Existing preference\n");
  const records = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    new MemoryStore(root).record("serious", input, `call-${i}`)));
  expect(new Set(records.map((record) => record.name)).size).toBe(8);
  await store.record("serious", input, "call-0");
  const text = await readFile(index, "utf8");
  expect(text).toStartWith("# Memory index\n\n");
  expect(text.match(/Keep Markdown files/g)).toHaveLength(8);
  expect(text.trim()).toEndWith("2000-01-01 | old | Existing conclusion | Existing preference");
  const content = await store.read("serious", { name: records[0].name });
  expect(content.results[0].metadata.summary).toBe(input.conclusion);
  expect(content.results[0].text).toContain(input.details);
  expect((await store.recall("serious")).spaces[0].recent).toHaveLength(5);
  await expect(store.record("serious", { ...input, details: "changed" }, "call-0")).rejects.toThrow("different content");
});

test("retry repairs an interrupted index update without recreating the record", async () => {
  const { root, store } = await fixture();
  const record = await store.record("serious", input, "repair");
  await rm(path.join(root, ".sessions/INDEX.md"));
  await store.record("serious", input, "repair");
  const index = await readFile(path.join(root, ".sessions/INDEX.md"), "utf8");
  expect(index).toContain(record.name.slice(11, -3));
});

test("frontmatter quotes round-trip punctuation and multiline YAML and preserve unknown metadata", async () => {
  const { root, store } = await fixture();
  const record = await store.record("serious", { ...input, conclusion: "中文: #标记\n第二行 | pipe", preferences: "yes: true" }, "yaml");
  const original = decode(await readFile(path.join(root, record.logicalPath), "utf8"));
  expect(original.metadata.summary).toBe("中文: #标记\n第二行 | pipe");
  const yaml = encode({ ...original.metadata, tags: ["中文", "sync"], custom: { enabled: true } }, original.body);
  expect(decode(yaml).metadata.custom).toEqual({ enabled: true });
  expect(decode(yaml).body).toBe(original.body);
  const block = yaml.replace('summary: "中文: #标记\\n第二行 | pipe"', 'summary: |\n  手动修改\n  第二行');
  expect(decode(block).metadata.summary).toBe("手动修改\n第二行\n");
});

test("migration backs up both spaces, preserves every body byte, and is idempotent", async () => {
  const { root, store } = await fixture();
  await mkdir(path.join(root, ".sessions/casual"), { recursive: true });
  const originals = {
    "MEMORY.md": "# Memory\r\nExisting preferences.\r\n",
    ".sessions/2000-01-01-old.md": "# Old\n## Summary\n- Conclusion / deliverables: Legacy summary\n\n## Details\nKeep this body.\n",
    ".sessions/casual/MEMORY.md": "# Private memory\nPrivate preference\n",
    ".sessions/casual/2001-02-03-private.md": "# 私有记录\n- 结论 / 产出: 原有摘要\n- 偏好 / 上下文: 原有偏好\n",
    ".sessions/INDEX.md": "# Original index\n2000-01-01 | old | old index summary | preferences\n",
    ".sessions/casual/INDEX.md": "# Original private index\n",
  };
  for (const [name, text] of Object.entries(originals)) await writeFile(path.join(root, name), text);
  const dry = await migrate(root, { dryRun: true });
  expect(dry.files).toBe(4);
  expect(dry.backups).toEqual([]);
  expect(await readFile(path.join(root, "MEMORY.md"), "utf8")).toBe(originals["MEMORY.md"]);
  const report = await migrate(root);
  expect(report.files).toBe(4);
  expect(report.backups).toHaveLength(2);
  for (const [name, text] of Object.entries(originals)) {
    if (name.endsWith("INDEX.md")) continue;
    expect(decode(await readFile(path.join(root, name), "utf8")).body).toBe(text);
  }
  for (const backup of report.backups) {
    const manifest = JSON.parse(await readFile(path.join(root, backup, "manifest.json"), "utf8"));
    for (const entry of manifest.files) {
      expect(await readFile(path.join(root, backup, entry.backup), "utf8")).toBe(originals[entry.path]);
    }
  }
  const first = await readFile(path.join(root, "MEMORY.md"), "utf8");
  expect((await migrate(root)).files).toBe(0);
  expect(await readFile(path.join(root, "MEMORY.md"), "utf8")).toBe(first);
  expect((await store.search("casual", { query: "原有摘要" })).results[0].metadata.type).toBe("session");
});

test("indexes derive from metadata after deletion or manual edits; duplicate IDs are reported", async () => {
  const { root, store } = await fixture();
  const record = await store.record("serious", input, "derive");
  await rm(path.join(root, ".sessions/INDEX.md"));
  const document = decode(await readFile(path.join(root, record.logicalPath), "utf8"));
  await writeFile(path.join(root, record.logicalPath), encode({ ...document.metadata, summary: "New summary" }, document.body));
  expect((await store.recall("serious")).spaces[0].recent[0]).toContain("New summary");
  expect((await store.read("serious", { name: "INDEX.md" })).results[0].text).toContain("New summary");
  await store.locked(() => store.rebuild("shared"));
  expect(await readFile(path.join(root, ".sessions/INDEX.md"), "utf8")).toContain("New summary");
  await writeFile(path.join(root, ".sessions/2000-01-01-conflict.md"), encode(document.metadata, document.body));
  await expect(store.recall("serious")).rejects.toThrow("Duplicate memory ID");
});

test("invalid frontmatter aborts migration before changing legacy files", async () => {
  const { root } = await fixture();
  await mkdir(path.join(root, ".sessions"));
  await writeFile(path.join(root, "MEMORY.md"), "# Original\n");
  await writeFile(path.join(root, ".sessions/2000-01-01-invalid.md"), "---\nschema_version: 999\n---\nBody\n");
  await expect(migrate(root)).rejects.toThrow("schema_version");
  expect(await readFile(path.join(root, "MEMORY.md"), "utf8")).toBe("# Original\n");
  expect(await readdir(path.join(root, ".sessions"))).toEqual(["2000-01-01-invalid.md"]);
});

test("empty placeholders stay untouched and do not become recalled memories", async () => {
  const { root, store } = await fixture();
  await mkdir(path.join(root, ".sessions"));
  await writeFile(path.join(root, ".sessions/2000-01-01-empty.md"), "");
  const report = await migrate(root);
  expect(report.files).toBe(0);
  expect(report.skippedEmpty).toEqual([".sessions/2000-01-01-empty.md"]);
  expect((await store.recall("serious")).spaces[0].recent).toEqual([]);
  expect(await readFile(path.join(root, ".sessions/2000-01-01-empty.md"), "utf8")).toBe("");
});

test("long-term updates preserve stable IDs and custom metadata", async () => {
  const { root, store } = await fixture();
  const first = (await store.read("serious", { name: "MEMORY.md" })).results[0];
  await store.update("serious", { content: "# Memory\nBefore", expectedRevision: first.revision });
  const document = decode(await readFile(path.join(root, ".sessions/MEMORY.md"), "utf8"));
  await writeFile(path.join(root, ".sessions/MEMORY.md"), encode({ ...document.metadata, tags: ["keep"] }, document.body));
  const current = (await store.read("serious", { name: "MEMORY.md" })).results[0];
  await store.update("serious", { content: "# Memory\nAfter", expectedRevision: current.revision });
  const updated = (await store.read("serious", { name: "MEMORY.md" })).results[0];
  expect(updated.metadata.id).toBe(document.metadata.id);
  expect(updated.metadata.created_at).toBe(document.metadata.created_at);
  expect(updated.metadata.tags).toEqual(["keep"]);
  expect(updated.text).toBe("# Memory\nAfter\n");
});

test("long-term updates reject stale revisions and preserve the successful writer", async () => {
  const { store } = await fixture();
  const { revision } = (await store.read("serious", { name: "MEMORY.md" })).results[0];
  const writes = await Promise.allSettled([
    store.update("serious", { content: "# Memory\nFirst", expectedRevision: revision }),
    store.update("serious", { content: "# Memory\nSecond", expectedRevision: revision }),
  ]);
  expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
  expect(writes.filter((write) => write.status === "rejected")[0].reason.message).toContain("Memory changed");
  const current = (await store.read("serious", { name: "MEMORY.md" })).results[0];
  expect(current.revision).not.toBe(revision);
  expect(current.text).toMatch(/^# Memory\n(First|Second)\n$/);
});

test("search is literal, multilingual, bounded and follows external file edits", async () => {
  const { root, store } = await fixture();
  const record = await store.record("serious", { ...input, details: "中文记忆 Bun [literal] " + "x".repeat(2000) }, "search");
  const result = await store.search("serious", { query: "中文记忆 bun [literal]", limit: 1 });
  expect(result.matches).toBe(1);
  expect(result.results[0].snippet.length).toBeLessThanOrEqual(700);
  const page = (await store.read("serious", { name: record.name, limit: 20 })).results[0];
  expect(page.truncated).toBe(true);
  const next = (await store.read("serious", { name: record.name, offset: 20, limit: 20 })).results[0];
  expect(next.revision).toBe(page.revision);
  await writeFile(path.join(root, record.logicalPath), "Externally edited record");
  expect((await store.search("serious", { query: "中文记忆" })).matches).toBe(0);
  expect((await store.search("serious", { query: "externally" })).matches).toBe(1);
});

test("memory paths reject traversal, private-directory aliases, and symlinks", async () => {
  const { root, store } = await fixture();
  for (const name of ["../../outside.md", ".sessions/casual/MEMORY.md", "/etc/passwd"]) {
    await expect(store.read("serious", { name })).rejects.toThrow("without directories");
  }
  await writeFile(path.join(root, "outside.md"), "untouched");
  await symlink(path.join(root, "outside.md"), path.join(root, "MEMORY.md"));
  await expect(store.recall("serious")).rejects.toThrow("symlinks");
  await expect(store.update("serious", { content: "new", expectedRevision: "wrong" })).rejects.toThrow("symlinks");
  expect(await readFile(path.join(root, "outside.md"), "utf8")).toBe("untouched");
});

test("plugin uses execution context identity and honors host permission failures", async () => {
  const { root } = await fixture();
  const tools = new Map();
  const assertions = [];
  let denied = false;
  await plugin.setup({
    options: { root },
    tool: { transform: async (register) => register({ namespace() {}, add(tool) { tools.set(tool.name, tool); } }) },
    permission: { assert: async (request) => {
      assertions.push(request);
      if (denied) throw new Error("permission denied");
    } },
  });
  expect(tools.size).toBe(5);
  expect(tools.get("read").input.properties.section.type).toBe("string");
  const context = { agent: "casual", sessionID: "session", messageID: "message", id: "call" };
  const output = await tools.get("record").execute({ ...input, agent: "serious" }, context);
  expect(JSON.parse(output.content).scope).toBe("private");
  expect(assertions[0].agent).toBe("casual");
  expect(assertions[0].resources).toEqual(["private"]);
  const selected = JSON.parse((await tools.get("read").execute({ name: JSON.parse(output.content).name, scope: "private", section: "Details" }, context)).content).results[0];
  expect(selected.text).toBe(`## Details\n${input.details}\n`);
  expect(selected.metadata.topic).toBe(input.topic);
  await expect(tools.get("recall").execute({}, { ...context, agent: "temp" })).rejects.toThrow();
  await tools.get("recall").execute({}, { ...context, agent: "plan" });
  expect(assertions.at(-1).resources).toEqual(["shared"]);
  const count = assertions.length;
  await expect(tools.get("record").execute(input, { ...context, agent: "plan" })).rejects.toThrow("read-only");
  expect(assertions).toHaveLength(count);
  await tools.get("record").execute(input, { ...context, agent: "build", id: "build-call" });
  expect(assertions.at(-1).agent).toBe("build");
  expect(assertions.at(-1).resources).toEqual(["shared"]);
  denied = true;
  await expect(tools.get("update").execute({ content: "no", expectedRevision: "no" }, context)).rejects.toThrow("permission denied");
  expect((await createMemoryStore(root).read("casual", { name: "MEMORY.md", scope: "private" })).results[0].text).toBe("");
});
