// ATX headings outside fenced code; offsets count JavaScript string characters.
export function sections(body) {
  const headings = [];
  let offset = 0;
  let fence;
  for (const line of body.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const text = line.replace(/\r?\n$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = marker[1];
    } else {
      const match = /^ {0,3}(#{1,6})(?:[\t ]+(.+?)|[\t ]*)$/.exec(text);
      if (match) headings.push({ title: (match[2] ?? "").replace(/[\t ]+#+[\t ]*$/, "").trim(), level: match[1].length, start: offset });
    }
    offset += line.length;
  }
  const stack = [];
  for (const heading of headings) {
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop().end = heading.start;
    heading.end = body.length;
    stack.push(heading);
  }
  return headings;
}

export const descriptor = ({ title, level }) => ({ title, level });
export function replaceSection(body, title, content) {
  if (typeof title !== "string" || !title.trim()) throw new Error("section must be a non-empty exact heading title.");
  const matches = sections(body).filter((item) => item.title === title);
  if (!matches.length) throw new Error(`Section not found: ${title}.`);
  if (matches.length > 1) throw new Error(`Ambiguous section: ${title}.`);
  const target = matches[0];
  const replacement = `${content.trim()}\n\n`;
  const headings = sections(replacement);
  if (!headings.length || headings[0].start !== 0 || headings[0].title !== title || headings[0].level !== target.level) {
    throw new Error("Section content must start with the original heading title and level.");
  }
  if (headings.slice(1).some((item) => item.level <= target.level || item.title === title)) {
    throw new Error("Section content may contain only lower-level nested headings, without repeating the selected title.");
  }
  const probe = sections(`${replacement}${"#".repeat(target.level)} boundary\n`);
  if (!probe.some((item) => item.start === replacement.length)) throw new Error("Section content must close all fenced code blocks.");
  return body.slice(0, target.start) + replacement + body.slice(target.end);
}
const summaryTitles = new Set(["速览摘要", "摘要", "Summary", "Quick summary"]);
const navigationTitles = new Set(["内部导航与按需提取索引", "内部索引", "Navigation", "Index"]);

export function overview(body) {
  const headings = sections(body);
  const summary = headings.filter(({ title }) => summaryTitles.has(title));
  const selected = headings.filter(({ title }) => summaryTitles.has(title) || navigationTitles.has(title));
  // Merge overlapping summary/navigation sections so nested headings appear once.
  const ranges = [];
  for (const heading of selected) {
    if (!ranges.length || heading.start >= ranges.at(-1).end) ranges.push(heading);
  }
  const fullBody = summary.length === 0 && body.length <= 2000;
  const text = fullBody ? body : ranges.map(({ start, end }) => body.slice(start, end)).join("\n");
  return {
    text: text.slice(0, 10000), truncated: text.length > 10000, offset: 0, total: text.length,
    summaryFound: summary.length > 0,
    mode: fullBody ? "full" : "overview",
    sections: headings.slice(0, 100).map(descriptor), sectionsTotal: headings.length, sectionsTruncated: headings.length > 100,
    guidance: `${fullBody ? "No summary; short memory returned in full (at most 2000 characters)." : summary.length ? "Summary and navigation only." : "Summary missing."} Read MEMORY.md with an exact section title for details or to page summary/navigation; omit section to read the full body. Before update, read every page of the selected section (section update) or full body (whole-file update).`,
  };
}
