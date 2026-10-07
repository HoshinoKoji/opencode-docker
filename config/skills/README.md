# Shared skills

Consuming Compose services mount a skills directory read-only at
`/opt/claude-skills` (see `compose.yaml` for the chat workspace and the README
example for other projects). Put skills shared by every project in this
directory, or override `OPENCODE_SKILLS_SOURCE` with an absolute host path to
mount a different set (for example `$HOME/.claude/skills`).

Each skill lives in its own folder with a `SKILL.md` file:

```
config/skills/<skill-name>/SKILL.md
```

The neutral `config/opencode/opencode.jsonc` registers `/opt/claude-skills` via
`skills.paths`.
