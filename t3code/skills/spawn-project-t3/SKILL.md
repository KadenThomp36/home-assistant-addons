---
name: spawn-project-t3
description: Spawn a new project into THIS T3 Code add-on — write its context dump and register the project directory with the add-on's T3 Code server so you can start a context-loaded Claude thread for it from the T3 GUI (HA sidebar or tailnet). Runs inside the T3 Code Home Assistant add-on.
---

# spawn-project-t3 (add-on edition)

Split a new project into its own **T3 Code project** with a context dump that a
fresh Claude thread auto-inherits. This is the in-add-on version of the host
`spawn-project-t3` skill: it registers the project with **this add-on's** T3 server
(`--base-dir /data/t3code`), so it appears in the T3 GUI you reach from the Home
Assistant sidebar (ingress) or the tailnet (`t3code-ha`).

## When to use
- You (the orchestrator, working in the `/config` project) want to split off a new
  project managed in this add-on's T3 Code.
- You have a slug + a brief and want the project ready to start a Claude thread with
  full context.

## Key behavior
This skill does **NOT** start a process. T3 Code drives `claude` itself only when you
open the project in the GUI and start a thread — that thread's cwd is the project dir,
so it auto-loads `CLAUDE.md` (the symlinked dump). The dump is the point: it's how the
future thread gets its context.

## Inputs
- A short **kebab-case slug** (e.g. `garage-door-sensor`).
- A **brief**: what it is, goal, current state, key facts (entities/paths/IDs/
  endpoints), constraints, concrete first steps. Assume the reader has zero context.

## Procedure
1. **Write the context dump** to `/config/herdr-context/<slug>.md` — a true cold-start
   handoff. (This dir is shared with the Claude Terminal herdr add-on, so projects are
   common to both tools.)
2. **Register it** with the bundled script:
   ```
   bash ~/.claude/skills/spawn-project-t3/spawn-t3.sh <slug>
   ```
   The script creates `/config/herdr-context/<slug>/CLAUDE.md` → symlink to the dump,
   then runs `t3 project add <dir> --base-dir /data/t3code --title <slug>` (idempotent).
   The running add-on server picks the project up live — **no restart needed**.
3. **Tell the user** to open T3 Code (HA sidebar, or `https://t3code-ha.tail2c61c0.ts.net`),
   select the `<slug>` project, start a thread, and **pick a Claude model** (e.g. Opus 4.8).

## Gotchas
- **Pick a Claude model** (provider instance `claudeAgent`) when starting a thread —
  T3's default provider (`codex`) is not installed here, so `codex` fails with
  `spawn codex ENOENT`. The add-on already ships the global text-generation model set
  to Claude, so auto-titles/branch names won't throw the red "Runtime error".
- **No mid-session resume** — T3 Code only starts fresh threads; it can't adopt a herdr
  session UUID.
- **Dual-writer rule** — never run the same project live in BOTH a herdr agent and a
  T3 Code thread at once (two writers to the same `~/.claude/*.jsonl` corrupts it).
- **Overrides via env:** `T3CODE_HOME` (add-on default `/data/t3code`), `T3CODE_URL`,
  `HERDR_CONTEXT_DIR` (base dir, default `/config/herdr-context`).
