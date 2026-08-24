# Changelog

## 0.4.3

**New option `claude_oauth_token`** — a long-lived Claude Code token from
`claude setup-token`, exported as `CLAUDE_CODE_OAUTH_TOKEN` before `t3 serve` starts so
every `claude` subprocess inherits it. Motivation: the Claude login copied from the
herdr add-on's volume got orphaned ("OAuth session expired and could not be refreshed")
because browser-login credentials rotate their refresh token — two installs sharing a
copied `.credentials.json` invalidate each other. The setup-token flow does no rotation,
so it's immune. DOCS now cover both auth paths and the recovery procedure.

## 0.4.2

**Bundles the `spawn-t3` skill (add-on edition), replacing `spawn-project-t3`.**
Port of the host `spawn-t3` skill: the orchestrator thread (the `/config` project)
writes a context dump to `/config/herdr-context/<slug>.md`, and the script symlinks it
as the project-dir CLAUDE.md, mints a short-lived bearer (`t3 auth session issue`),
then drives `POST /api/orchestration/dispatch` on the loopback `t3 serve` (:3774) to
find-or-create the project (dedupe by workspace root) and dispatch `thread.create` +
`thread.turn.start` — a context-loaded claude-fable-5 thread starts working
immediately and the script prints its tailnet URL. (Two dispatches on purpose: the
HTTP path rejects `bootstrap.createThread` on `thread.turn.start`.) The old
`spawn-project-t3` (register-only, no thread) is removed, and `run.sh` now purges it
from the persistent `~/.claude/skills` on start. Verified end-to-end in the running
add-on with a throwaway spawn before shipping.

## 0.4.1

**Fix: HA sidebar showed "Primary environment request failed during fetch-session-state
(HTTP 404)".** T3 ≥0.0.33's SPA resolves its API/WS base from `window.location.origin`
only (`resolvePrimaryEnvironmentHttpUrl` overwrites the URL pathname), so under HA
ingress every runtime call dropped the `/api/hassio_ingress/<token>` sub-path and hit
HA core instead of the add-on. The 0.0.28-era SPA followed `location.pathname`; that
behavior is gone upstream and the `VITE_HTTP_URL` override is build-time-only. The
ingress proxy now injects a shim into `index.html` that patches
`fetch`/`WebSocket`/`EventSource` to re-prefix same-host requests with the ingress
path. Tailnet/pairing access is unaffected (served at origin root).

## 0.4.0

**Add-on revived** (was decommissioned 2026-07-21) as the in-HA replacement for the
"Claude Terminal (herdr)" add-on, and modernized for current T3:

- **T3 0.0.28 → 0.0.33.** All CLI surfaces the add-on scripts use (`t3 serve`,
  `t3 auth session issue/list/revoke`, `t3 project add`) verified unchanged against a
  live 0.0.33 server.
- **Ingress auth fixed for T3 ≥0.0.33:** the session cookie name is now
  instance-scoped (`t3_session_<port>_<id>`), so the old hardcoded `t3_session=`
  injection was silently ignored and ingress would have landed on a pairing screen.
  The proxy now discovers the cookie name from `/api/auth/session` and additionally
  injects an `Authorization: Bearer` header (both verified accepted by 0.0.33).
- Default Claude model bumped `claude-opus-4-8` → `claude-opus-5` (settings schema
  itself is unchanged in 0.0.33; the `claude_model`/`claude_effort` options still
  seed it on first run only).

## 0.3.0

Bundles the **`spawn-project-t3`** Claude skill (add-on edition), installed to
`~/.claude/skills` on every start. It lets the orchestrator (the `/config` project's
Claude thread) split off a new project — write a context dump under
`/config/herdr-context/<slug>.md` and register it with this add-on's T3 server
(`t3 project add --base-dir /data/t3code`) so it appears live in the T3 GUI. The
in-add-on analogue of the host `spawn-project-t3`.

## 0.2.0

Optional **tailnet-only access**. Set `tailscale_authkey` (and optionally
`tailscale_hostname`, default `t3code-ha`) and the add-on joins your tailnet in
userspace-networking mode (no TUN/privileges) and `tailscale serve`s the T3 server
over HTTPS at `https://<hostname>.<your-tailnet>.ts.net`. Tailnet clients connect
with T3's native pairing (`t3 auth pairing create`), so you can add the add-on as a
Remote-link **environment** in the T3 desktop/mobile client. The HA ingress path is
unchanged — both proxy to the same loopback `t3 serve`. Leave the key empty to stay
ingress-only.

## 0.1.0

Initial release of the **T3 Code** add-on — T3 Code's chat GUI (the harness that
drives the Claude Code CLI) embedded directly in the Home Assistant dashboard via
ingress. The T3 Code counterpart to the "Claude Terminal (herdr)" add-on: where that
gives you a web *terminal* running `claude`, this gives you T3 Code's own thread-based
chat GUI in the HA sidebar.

- Installs `t3` and `@anthropic-ai/claude-code` from npm (`@latest`, rebuilt each
  image build — nothing to hand-bump). Multi-arch: amd64 + aarch64.
- Runs `t3 serve` headless on loopback behind an in-container reverse proxy that
  injects a T3 session cookie, so the already-HA-authenticated user is transparently
  authorized — **no T3 pairing prompt**. The proxy also rewrites the SPA's static
  asset paths for the HA ingress sub-path.
- Ships a default `settings.json` that pins the **Claude** provider and a Claude
  text-generation model, so threads and auto-title/branch-name generation never fall
  back to the (uninstalled) `codex` model.
- Persists everything under `/data`: T3 state (projects, threads, auth, settings) in
  `/data/t3code`, and Claude Code's login in `/data/home/.claude`.
- Sets `IS_SANDBOX=1` so T3's `claude --dangerously-skip-permissions` runs as root
  inside the container.
