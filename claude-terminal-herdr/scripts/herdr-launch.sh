#!/bin/bash
# herdr launch wrapper for the Claude Terminal (herdr) add-on.
#
# Replaces the old `tmux new-session -A -s claude 'claude'` behavior:
#   - launches/attaches herdr's persistent default session (survives ttyd reconnects)
#   - ensures a single persistent "parent" Claude agent exists in that session
#
# herdr reads its config + stores its socket/session state under $XDG_CONFIG_HOME/herdr
# (run.sh points XDG_CONFIG_HOME at /data/.config, which is a persistent mapped volume).
#
# herdr 0.8.0 API note: `agent start` no longer creates layout. It attaches an agent to
# an EXISTING interactive shell pane via `--kind`/`--pane`, and the agent inherits that
# pane's cwd. The pre-0.8 form (`agent start parent --cwd /config -- claude`) now fails
# with "unknown option: --cwd", so we locate the session's first agent-free pane and
# start Claude there instead. WORKDIR is /config, so that pane is already in /config.

set -uo pipefail

# Print the first pane that has no agent in it. On a normal first launch that's the
# default workspace's root shell pane; on restore it skips panes whose agents came back.
free_pane() {
  local busy
  busy="$(herdr agent list 2>/dev/null | jq -c '[.result.agents[].pane_id]' 2>/dev/null)"
  [ -n "$busy" ] || busy='[]'
  herdr pane list 2>/dev/null \
    | jq -r --argjson busy "$busy" \
        'first(.result.panes[] | select(($busy | index(.pane_id)) | not) | .pane_id) // empty' \
        2>/dev/null
}

# Background: once the herdr server is up (started by the foreground `herdr` below),
# seed the persistent parent Claude agent exactly once. On reconnect it already
# exists, so this is a no-op.
(
  for _ in $(seq 1 30); do
    if herdr agent get parent >/dev/null 2>&1; then
      break                      # parent agent already present (reconnect case)
    fi
    if herdr workspace list >/dev/null 2>&1; then
      # Server is reachable. A freshly created pane can briefly not be "an available
      # shell" yet (agent start requires an idle interactive prompt), so retry.
      for _ in 1 2 3 4 5; do
        pane="$(free_pane)"
        if [ -n "$pane" ] \
           && herdr agent start parent --kind claude --pane "$pane" >/dev/null 2>&1; then
          break
        fi
        sleep 1
      done
      break
    fi
    sleep 1
  done
) &

# Foreground: launch or attach the persistent session (starts the herdr server if needed).
exec herdr
