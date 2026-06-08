#!/bin/bash
# herdr launch wrapper for the Claude Terminal (herdr) add-on.
#
# Replaces the old `tmux new-session -A -s claude 'claude'` behavior:
#   - launches/attaches herdr's persistent default session (survives ttyd reconnects)
#   - ensures a single persistent "parent" Claude agent exists in that session
#
# herdr reads its config + stores its socket/session state under $XDG_CONFIG_HOME/herdr
# (run.sh points XDG_CONFIG_HOME at /data/.config, which is a persistent mapped volume).

set -uo pipefail

# Background: once the herdr server is up (started by the foreground `herdr` below),
# seed the persistent parent Claude agent exactly once. On reconnect it already
# exists, so this is a no-op.
(
  for _ in $(seq 1 30); do
    if herdr agent get parent >/dev/null 2>&1; then
      break                      # parent agent already present (reconnect case)
    fi
    if herdr workspace list >/dev/null 2>&1; then
      # server is reachable -> create the parent agent in the HA config dir
      herdr agent start parent --cwd /config -- claude >/dev/null 2>&1
      break
    fi
    sleep 1
  done
) &

# Foreground: launch or attach the persistent session (starts the herdr server if needed).
exec herdr
