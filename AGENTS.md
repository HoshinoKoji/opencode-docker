# AGENTS.md

This is a personal chat workspace tracked in Git. It contains OpenCode configuration, a Docker Compose setup for running OpenCode, and Markdown notes and temporary scripts. It has no application package manifest or project test/lint workflow; see `README.md` for container usage.

This project defines three switchable custom primary agents: `serious` (the default, writes to shared memory), `casual` (writes to its own private memory), and `temp` (temporary chat, with no memory access or recording). Each agent prompt defines its conversational style; this file defines memory file formats and procedures.

## Communication principles (all agents)

- Prefer affirmative descriptions that explain what something is, its characteristics, and when it applies.
- Avoid defining things primarily through negation or exclusion (for example, “X is ..., not ..., and not ...”). When distinctions matter, describe each option positively and explain its scope. Use a brief negation when it is necessary to correct a misunderstanding.

## Conversation memory workflow

### File conventions
- Shared memory (`serious` reads and writes; `casual` may read): `MEMORY.md`, `.sessions/YYYY-MM-DD-<topic>.md`, and `.sessions/INDEX.md`.
- Private `casual` memory (read and written by `casual` among these three custom modes): `.casual/MEMORY.md`, `.casual/YYYY-MM-DD-<topic>.md`, and `.casual/INDEX.md`. `serious` does not access this directory. Other agents, such as the built-in `build` agent, are not governed by these mode-specific conventions.
- Use a short English or pinyin slug for each record's topic; if that slug is already used on the same day, choose another unique one. Put index entries in **reverse chronological order**, one per line: `date | topic | one-sentence conclusion | key preferences`. Keep only still-relevant entries in long-term memory; mark obsolete entries as “deprecated” in place rather than deleting them.

### At the start of each session (`serious` and `casual` only; proactively, without prompting)
1. `serious` reads shared `MEMORY.md` and approximately the five most recent entries in `.sessions/INDEX.md`. `casual` also reads `.casual/MEMORY.md` and approximately the five most recent entries in `.casual/INDEX.md`. Skip files that do not exist.
2. Open relevant past records for details. `serious` searches only shared memory; `casual` may search both spaces.
3. Use the review to inform this session. When past memory conflicts with what the user says now, follow the user's current statement and update memory in the space this mode may write to. `casual` does not automatically update shared memory.

### Recording conversations
- `serious`: by default, make one record in shared memory when each topic or task concludes; do not read or write `.casual/`.
- `casual`: by default, make one record in its private memory when each topic or task concludes; write to shared memory only when the user explicitly asks to share specific information.
- Neither mode needs to record every reply. If a topic is unfinished when switching topics or ending the session, record the current progress and open questions.
- `temp`: do not read or write either memory space, review past conversations, or retroactively record chats in this mode. To save a discussion, ask the user to switch to another mode and discuss what to record there.
- To isolate previously loaded session context in `temp`, start a new session before switching to `temp`; changing agents within one session does not erase prior messages.
- Likewise, start a new session when switching from `casual` to `serious` if private `casual` content needs to be isolated; tool permissions cannot erase earlier messages in the same session.
- If the user explicitly says “do not record,” do not create a conversation record or update the index or long-term memory for that topic. Do not retroactively record `casual` conversations after switching to `serious`.

When recording:
1. Create `YYYY-MM-DD-<topic>.md` in the current mode's memory space using the template below: begin with a concise summary, then add details that make it possible to resume the discussion later.
2. Prepend a new entry to `INDEX.md` in the same space.
3. Merge only newly learned, enduring preferences or facts into that space's `MEMORY.md`. Deduplicate; do not turn it into a chronological log. Leave it untouched if there is nothing enduring to add. Exclude passwords, tokens, and other sensitive details that do not need to be retained.

### Conversation record template
```
# <topic>
## Summary
- Date: YYYY-MM-DD
- Goal:
- Conclusion / deliverables:
- Key decisions:
- Next steps / open questions:
- Preferences / context:

## Details
- Background and request:
- Discussion and progress:
- Rationale and tradeoffs:
- Outcome and follow-up:
```

### Principles
- Keep the summary brief. Include enough concrete detail in the longer record for future retrieval and continuation: the user's original question or key wording, relevant background, important clarifications and changes, actions taken, reasoning and tradeoffs, output locations, and open questions. Record only what happened and is useful; omit empty template fields.
- Follow the user's specific instructions about the scope, format, and level of detail. Otherwise, choose the detail level based on the topic's complexity and future retrieval value. A simple chat can have a short record; complex tasks need the important steps and decisions. Do not transcribe the entire exchange by default; include more of the user's wording or process when requested.
- When using memory to produce new work, integrate relevant context naturally instead of mechanically listing old entries, filenames, or phrases such as “according to past records.” Cite a specific record when the user asks for provenance or it helps verify a claim. Distinguish past statements from facts verified now, and prioritize the user's current instructions.
- When recording for the first time, create the appropriate directory, index, and long-term memory file as needed. If the directory is empty, simply say that there are no past sessions yet.
