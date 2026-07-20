#!/usr/bin/env bash
# spawn-t3.sh — register a project directory with THIS add-on's T3 Code server so a
# context-loaded Claude thread can be started for it from the T3 GUI (HA sidebar or
# tailnet). Part of the `spawn-project-t3` skill (add-on edition).
#
# Usage: spawn-t3.sh <slug> [context_base_dir]
# Precondition: <base>/<slug>.md (the project's context dump) already exists;
# the orchestrator writes it before calling this.
#
# This does NOT start an agent process. T3 Code drives `claude` itself when YOU open
# the project in the GUI and start a thread — that thread's cwd is the project dir, so
# it auto-loads CLAUDE.md (= the dump).
set -uo pipefail

SLUG="${1:?usage: spawn-t3.sh <slug> [base_dir]}"
BASE="${2:-${HERDR_CONTEXT_DIR:-}}"
if [ -z "$BASE" ]; then
  if [ -d /config ] && [ -w /config ]; then BASE="/config/herdr-context"; else BASE="$HOME/herdr-context"; fi
fi

# --- T3 Code environment (this add-on) ---
T3_HOME="${T3CODE_HOME:-/data/t3code}"
T3_URL="${T3CODE_URL:-https://t3code-ha.tail2c61c0.ts.net}"

command -v t3 >/dev/null 2>&1 || { echo "ERROR: t3 CLI not found on PATH"; exit 1; }

DUMP="$BASE/$SLUG.md"
[ -f "$DUMP" ] || { echo "ERROR: context dump not found: $DUMP — write it before spawning"; exit 1; }

PROJ_DIR="$BASE/$SLUG"
mkdir -p "$PROJ_DIR"
# Per-project CLAUDE.md so the T3 thread (cwd = PROJ_DIR) auto-inherits the dump.
ln -sf "../$SLUG.md" "$PROJ_DIR/CLAUDE.md"

# Register the project. `t3 project add` errors with ProjectAlreadyExistsError if this
# workspace root is already a project — treat that as success.
add_out="$(T3CODE_HOME="$T3_HOME" t3 project add "$PROJ_DIR" --base-dir "$T3_HOME" --title "$SLUG" 2>&1)"
add_rc=$?
if [ $add_rc -ne 0 ]; then
  if printf '%s' "$add_out" | grep -qiE 'AlreadyExists|already a project|already exists'; then
    echo "Project for '$PROJ_DIR' already exists in T3 Code — leaving it as-is."
  else
    echo "ERROR: t3 project add failed:"; printf '%s\n' "$add_out" | grep -viE '^\[|INFO|migrations|Running all' | tail -5
    exit 1
  fi
else
  printf '%s\n' "$add_out" | grep -viE '^\[|INFO|migrations|Running all' | tail -2
fi

# The running add-on server picks up the new project on its own — no restart needed.
echo "Registered T3 Code project '$SLUG':"
echo "  dir   : $PROJ_DIR   (CLAUDE.md -> $SLUG.md, auto-inherited by new threads)"
echo "  dump  : $DUMP"
echo "  open  : $T3_URL  → project '$SLUG' → start a thread and pick a Claude model (e.g. Opus 4.8)"
