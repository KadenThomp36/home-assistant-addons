# Changelog

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
