# T3 Code for Home Assistant

T3 Code's chat GUI — the harness that drives the Claude Code CLI — embedded in the
Home Assistant dashboard via ingress. Start and resume Claude coding threads from the
HA sidebar on phone or desktop.

The T3 Code counterpart to the **Claude Terminal (herdr)** add-on: that one gives you a
web *terminal* running `claude`; this one gives you T3 Code's own thread-based chat
interface.

- **Seamless auth** — Home Assistant ingress authenticates you; an in-container proxy
  injects the T3 session token, so there is no separate T3 pairing step.
- **Claude-ready out of the box** — ships a `settings.json` that selects a Claude model,
  avoiding the `codex`-default pitfalls.
- **Persistent** — projects, threads and Claude Code login survive restarts/updates
  under `/data`.
- **Multi-arch** — amd64 and aarch64 (both `t3` and Claude Code are npm/Node packages).

See [DOCS.md](DOCS.md) for setup and options.
