import path from "node:path";

export const help = `Usage: memory-mcp.sh --root DIR [--space shared|private|both] [--read-only]

--root DIR   Existing workspace; defaults to MEMORY_ROOT (required otherwise).
--backend    sqlite only; Markdown runtime is unsupported.
             Requires an explicit absolute root.
--space      Allowed space, default shared. both reads both; writes need scope.
--read-only  Expose only recall/search/read and deny all writes.
-h, --help   Print this help to stderr without opening memory.
Value flags also accept --flag=VALUE. No dependency installation at startup.
External MCP policy is configured here; it does not authenticate harness agents.
`;

export function parseOptions(args, env = process.env) {
  const options = { space: "shared", readOnly: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--read-only") { options.readOnly = true; continue; }
    const match = /^--(root|space|backend)(?:=(.*))?$/s.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}. Use --help.`);
    const value = match[2] ?? args[++i];
    if (!value?.trim() || value.startsWith("-")) throw new Error(`--${match[1]} requires a value.`);
    options[match[1]] = value;
  }
  if (!["shared", "private", "both"].includes(options.space)) throw new Error("--space must be shared, private, or both.");
  const root = options.root ?? env.MEMORY_ROOT;
  if (!root?.trim()) throw new Error("Set --root DIR or MEMORY_ROOT to an existing memory workspace.");
  const backend = options.backend ?? env.MEMORY_BACKEND ?? "sqlite";
  if (backend !== "sqlite") throw new Error("Only the sqlite memory backend is supported.");
  if (!path.isAbsolute(root)) throw new Error("SQLite requires an absolute memory root.");
  return { ...options, backend, root: path.resolve(root) };
}
