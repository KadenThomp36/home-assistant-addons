#!/usr/bin/env bash
# spawn.sh — create a named herdr workspace for a project and launch a
# context-loaded Claude agent in it. Part of the `spawn-project` skill.
#
# Usage: spawn.sh <slug> [context_base_dir]
# Precondition: <base>/<slug>.md (the project's context dump) already exists;
# the orchestrator writes it before calling this.
set -uo pipefail

SLUG="${1:?usage: spawn.sh <slug> [base_dir]}"
BASE="${2:-${HERDR_CONTEXT_DIR:-}}"
if [ -z "$BASE" ]; then
  # Sensible defaults: the HA add-on persists under /config; otherwise ~/herdr-context.
  if [ -d /config ] && [ -w /config ]; then BASE="/config/herdr-context"; else BASE="$HOME/herdr-context"; fi
fi

[ "${HERDR_ENV:-}" = "1" ] || { echo "ERROR: not running inside herdr (HERDR_ENV != 1)"; exit 1; }
command -v herdr >/dev/null 2>&1 || { echo "ERROR: herdr CLI not found on PATH"; exit 1; }

DUMP="$BASE/$SLUG.md"
[ -f "$DUMP" ] || { echo "ERROR: context dump not found: $DUMP — write it before spawning"; exit 1; }

PROJ_DIR="$BASE/$SLUG"
mkdir -p "$PROJ_DIR"
# Per-project CLAUDE.md so the spawned agent auto-inherits the dump from its cwd.
ln -sf "../$SLUG.md" "$PROJ_DIR/CLAUDE.md"

# Make herdr agent-aware (sidebar status). Idempotent.
herdr integration install claude >/dev/null 2>&1 || true

# Don't duplicate: agent names must be unique. If it exists, just focus it.
if herdr agent get "$SLUG" >/dev/null 2>&1; then
  echo "Agent '$SLUG' already exists — focusing its workspace instead of recreating."
  herdr agent focus "$SLUG" >/dev/null 2>&1 || true
  exit 0
fi

# Create the workspace; its first pane shows the dump for human reading.
pane=$(herdr workspace create --cwd "$PROJ_DIR" --label "$SLUG" --no-focus \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])') || {
    echo "ERROR: failed to create workspace"; exit 1; }
herdr pane rename "$pane" "${SLUG}-context" >/dev/null 2>&1 || true
herdr pane run "$pane" "cat '$DUMP'" >/dev/null 2>&1 || true

# Resolve the workspace id by label, then launch the agent.
# Unique name = slug; cwd = project dir so claude auto-loads CLAUDE.md (the dump).
wid=$(herdr workspace list \
  | python3 -c "import json,sys; print(next(w['workspace_id'] for w in json.load(sys.stdin)['result']['workspaces'] if w['label']=='$SLUG'))") || {
    echo "ERROR: could not resolve workspace id for '$SLUG'"; exit 1; }
herdr agent start "$SLUG" --workspace "$wid" --cwd "$PROJ_DIR" --no-focus -- claude >/dev/null || {
    echo "ERROR: failed to start agent"; exit 1; }

echo "Spawned project '$SLUG':"
echo "  workspace : $wid (label: $SLUG)"
echo "  agent     : $SLUG  (cwd $PROJ_DIR; auto-loads CLAUDE.md -> $SLUG.md)"
echo "  dump      : $DUMP"
echo "Open the '$SLUG' workspace in herdr; the agent is ready with full context."
