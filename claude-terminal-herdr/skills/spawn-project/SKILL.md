---
name: spawn-project
description: Spawn a new project into its own herdr workspace with a dedicated, context-loaded Claude agent. Use from the orchestrator session when starting a distinct new effort that should run in isolation instead of polluting the current session. Requires running inside herdr (HERDR_ENV=1).
---

# spawn-project

Split a new project out of this (orchestrator) session into its own **named herdr
workspace** running a dedicated Claude agent that **auto-inherits** the project's
context. Keeps the orchestrator session clean; each project gets isolated context.

## When to use
You (the orchestrator) are about to start a distinct new project/effort and want it
to live in its own herdr workspace + agent rather than continuing inline here.

## Inputs (from the user's request / current context)
- A short **kebab-case slug** (e.g. `grafana-dashboards`, `zwave-migration`).
- A **brief**: what it is, the goal, current state, key facts (paths, IDs, endpoints,
  hostnames), constraints, and concrete first steps.

## Procedure
1. **Verify herdr.** Run `echo $HERDR_ENV` — it must be `1`. If not, stop and tell the
   user this skill only works inside a herdr session.
2. **Pick the slug** (kebab-case) and the context base dir. The base defaults to
   `/config/herdr-context` in the HA add-on or `~/herdr-context` elsewhere; override
   by exporting `HERDR_CONTEXT_DIR` or passing it as the 2nd arg in step 4.
3. **Write the context dump** to `<base>/<slug>.md` — a true cold-start handoff:
   goal, current state, what's known/tried, key facts, constraints, and next steps.
   Assume the reader (the new agent) has zero prior context. Be thorough.
4. **Spawn it** with the bundled script:
   ```
   bash ~/.claude/skills/spawn-project/spawn.sh <slug>
   ```
   (Optionally append a base dir: `... spawn.sh <slug> /config/herdr-context`.)
   The script: creates `<base>/<slug>/CLAUDE.md` → symlink to the dump (auto-inherit),
   installs the herdr claude integration (idempotent), creates a named workspace
   showing the dump in its pane, and launches a uniquely-named `claude` agent whose
   cwd is the project dir so it loads the dump as `CLAUDE.md`.
5. **Report** the workspace + agent to the user, and stay in this session as the
   coordinator. Do per-project work inside the new workspace.

## Gotchas (handled by the script)
- herdr **agent names must be unique** — the agent is named after the slug; if it
  already exists the script focuses that workspace instead of duplicating.
- herdr **pane IDs are session-local** — re-resolve by agent name: `herdr agent get <slug>`.
- The agent inherits context only via `<base>/<slug>/CLAUDE.md` (a symlink to the
  dump), so editing `<base>/<slug>.md` changes what *future* launches inherit.
