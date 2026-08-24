# T3 Code for Home Assistant

Run [T3 Code](https://github.com/pingdotgg/t3code) — the agent GUI that drives the
Claude Code CLI — directly inside Home Assistant. Start and resume Claude coding
threads from the HA sidebar on phone or desktop. This is the T3 Code sibling of the
"Claude Terminal (herdr)" add-on: instead of a web terminal, you get T3 Code's own
thread-based chat interface.

## How it works

- The add-on runs `t3 serve` headless on a loopback port and puts a tiny reverse
  proxy in front of it on the ingress port.
- Home Assistant ingress authenticates **you** (your HA login) and proxies you to that
  proxy. The proxy injects a T3 session token on every request, so T3 authorizes you
  automatically — **you never see a T3 pairing screen**.
- All state lives under `/data` and survives restarts and updates:
  - `/data/t3code` — projects, threads, T3 auth/sessions, `settings.json`
  - `/data/home/.claude` — your Claude Code login

## First-run setup

1. **Install & start** the add-on, then open it from the sidebar ("T3 Code").
2. **Authenticate Claude Code (one time).** T3 drives the `claude` CLI, which needs
   auth. Two options, best first:
   - **Recommended — long-lived token:** run `claude setup-token` on any machine where
     you can complete the browser OAuth flow, and paste the printed token into the
     add-on's `claude_oauth_token` option, then restart the add-on. This token does no
     refresh rotation, so it never gets orphaned if the same Claude login is used
     elsewhere too.
   - **Interactive login:** from a terminal with a TTY (e.g. the SSH add-on's web
     terminal in the HA sidebar):
     `docker exec -it app_dcc88dd2_t3code bash`, then `export HOME=/data/home` and
     `claude /login`; open the printed URL in a browser and paste the code back. The
     credential is saved to `/data/home/.claude` and persists across updates.
     ⚠️ Don't *copy* `.credentials.json` from another live install — browser-login
     credentials rotate their refresh token, so whichever copy refreshes first
     orphans the other ("OAuth session expired and could not be refreshed").
3. **Start a thread.** Pick a project directory and start a thread. The add-on ships a
   default configuration that already selects a **Claude** model, so you won't hit
   `spawn codex ENOENT` or the red "Runtime error" that occurs when T3 defaults to the
   uninstalled `codex` model.

## Working directories

The add-on maps these Home Assistant directories read/write, so you can point threads at
them:

| Path       | Contents                        |
|------------|---------------------------------|
| `/config`  | Home Assistant configuration    |
| `/share`   | HA shared storage               |
| `/addons`  | Local add-on sources            |

Your own projects and their git history live under `/data/t3code` state; use
`t3 project add` from the terminal, or the GUI, to register directories.

## Options

| Option                     | Default            | Description                                                        |
|----------------------------|--------------------|--------------------------------------------------------------------|
| `claude_model`             | `claude-opus-4-8`  | Default Claude model seeded into `settings.json` **on first run**. |
| `claude_effort`            | `high`             | Reasoning effort for the default model (`high`/`medium`/`low`).    |
| `persistent_apk_packages`  | `[]`               | Extra Alpine packages installed at every start.                    |
| `persistent_npm_packages`  | `[]`               | Extra global npm packages installed at every start.                |

`claude_model` / `claude_effort` seed the default only when no `settings.json` exists
yet; after that, change models per-thread (or edit settings) in the T3 Code GUI.

## Privacy

This add-on stays local. It does **not** enable **T3 Connect** (t3.gg's hosted relay).
You reach it only through Home Assistant ingress (and HA's own remote access, e.g. your
tailnet). Nothing is routed through a third-party relay.

## Notes

- `t3` and `@anthropic-ai/claude-code` are installed from npm `@latest` at image build
  time — updating the add-on rebuilds them to current. There is no version to hand-bump.
- If T3's server crashes, the add-on exits and Home Assistant restarts it.
