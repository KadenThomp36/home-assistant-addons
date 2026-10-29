---
name: spawn-t3
description: Spawn a new project into its own T3 Code project + thread with a dedicated, context-loaded Claude agent — add-on edition. Use from the orchestrator thread (the /config project) inside the T3 Code HA add-on when starting a distinct new effort that should run in isolation instead of polluting the orchestrator thread. Supersedes spawn-project-t3.
---

# spawn-t3 (HA add-on edition)

Split a new project out of this (orchestrator) thread into its own **T3 Code
project** with a fresh thread running a dedicated Claude agent that
**auto-inherits** the project's context. Keeps the orchestrator thread clean;
each project gets isolated context — and is visible/steerable from the HA
sidebar (ingress) or any paired device (tailnet,
https://t3code-ha-1.tail2c61c0.ts.net).

This is the add-on port of the host `spawn-t3` skill (which targets the
`t3 serve` on chungtu). Same context-dump convention as the herdr skills, so a
project spawned here can also be opened as a herdr workspace and vice versa.

## Inputs (from the user's request / current context)
- A short **kebab-case slug** (e.g. `grafana-dashboards`, `zwave-migration`).
- A **brief**: what it is, the goal, current state, key facts (paths, IDs,
  endpoints, hostnames), constraints, and concrete first steps.

## Procedure
1. **Pick the slug** (kebab-case). Context base dir is `/config/herdr-context`
   (shared with the herdr add-on's workspaces; override with `-b <dir>`).
2. **Write the context dump** to `<base>/<slug>.md` — a true cold-start handoff:
   goal, current state, what's known/tried, key facts, constraints, and next
   steps. Assume the reader (the new agent) has zero prior context. Be thorough.
3. **Spawn it** with the bundled script:
   ```
   bash ~/.claude/skills/spawn-t3/spawn-t3.sh <slug>
   ```
   Optional flags: `-m "custom kickoff message"` (the first user message the new
   agent receives; defaults to "read your CLAUDE.md, confirm understanding, and
   start on the first next step"), `-b <context_base_dir>`.
   The script: creates `<base>/<slug>/CLAUDE.md` → symlink to the dump
   (auto-inherit), mints a short-lived T3 bearer token (`t3 auth session issue`),
   finds-or-creates the T3 project for that dir via `GET /api/projects` +
   `POST /api/projects/mutate` (`project.create`), then sends `thread.create` +
   `message.dispatch` (`dispatchMode: start_immediately`) over the WebSocket RPC
   (`orchestration.dispatchCommand`, via the bundled `t3-rpc.mjs`) so
   the agent (T3 Code's default model from Settings, full-access) starts
   working immediately.
4. **Report** the printed thread URL to the user, and stay in this thread as
   the coordinator. Do per-project work inside the new thread.

## Gotchas (mostly handled by the script)
- **Never pin a model in the script.** Spawned threads take T3 Code's default
  (`defaultModelSelection` in `<T3_HOME>/userdata/settings.json`, set from T3's
  Settings). A hardcoded `claude-opus-5` kept spawning stale Opus 5 threads after
  T3 moved to 5.5. To change the model, change T3's default.
- The script talks to the **loopback `t3 serve` on :3774**, not the ingress
  proxy on :3773 — the proxy injects its own full-scope bearer, which would mask
  auth failures.
- **Project dedupe is by workspace root** (`<base>/<slug>`), not title — respawning
  a slug reuses the existing T3 project and just starts a new thread in it. Old
  threads keep running; archive them from the GUI if superseded.
- The agent inherits context only via `<base>/<slug>/CLAUDE.md` (a symlink to the
  dump), so editing `<base>/<slug>.md` changes what *future* threads inherit.
- **T3 ≥ 0.1.0 (Orchestrator V2) removed `/api/orchestration/dispatch` and
  `/api/orchestration/snapshot`.** Thread commands now go over the `/ws` Effect-RPC
  socket (JSON serialization): mint a ticket with `POST /api/auth/websocket-ticket`
  (bearer), connect to `/ws?wsTicket=…&orchestrationProtocol=2`, send
  `{"_tag":"Request","id":"1","tag":"orchestration.dispatchCommand","payload":…,"headers":[]}`.
  `t3-rpc.mjs` does exactly this. Projects stay plain HTTP.
- V2 commands require `createdBy` (`"user"`) + `creationSource` (`"server"`); there is
  no `createdAt`. `thread.turn.start` is gone — the first turn is a `message.dispatch`
  with `dispatchMode:{type:"start_immediately"}`. Thread is still created first.
- Schemas: `packages/contracts/src/orchestrationV2.ts` (`OrchestrationV2Command`) and
  `project.ts` (`ProjectMutation`) in the upstream repo at the release tag (the
  standalone binary no longer ships a usable sourcemap). If a `t3` upgrade breaks
  spawning, re-check them there.
- The printed URL only works from a device on the tailnet that has **paired**
  with this add-on's T3 (`t3 pair --base-dir /data/t3code --tailscale` mints a
  token/QR). From the HA sidebar, find the thread via the project list instead.
- This skill ships in the add-on image (`/opt/t3code/skills/`) and is refreshed
  into `~/.claude/skills/` on every add-on start — edit it in the repo
  (`t3code/skills/spawn-t3/`), not in place, or changes die on the next update.
