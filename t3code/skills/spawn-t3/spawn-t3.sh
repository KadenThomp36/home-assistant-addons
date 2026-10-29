#!/usr/bin/env bash
# spawn-t3.sh — spawn a project into its own T3 Code project + thread with a
# context-loaded Claude agent. Add-on edition of the host `spawn-t3` skill
# (T3 twin of the herdr `spawn-project` skill); supersedes `spawn-project-t3`,
# which only registered the project without starting an agent.
#
# Usage: spawn-t3.sh <slug> [-m "kickoff message"] [-b <context_base_dir>]
# Precondition: <base>/<slug>.md (the project's context dump) already exists;
# the orchestrator writes it before calling this.
set -uo pipefail

T3_HOME=/data/t3code
# Loopback `t3 serve` (:3774), NOT the ingress proxy (:3773) — the proxy would
# inject its own full-scope bearer, masking auth failures in this script.
T3_URL=http://127.0.0.1:3774
TAILNET_URL=https://t3code-ha-1.tail2c61c0.ts.net

SLUG="${1:?usage: spawn-t3.sh <slug> [-m msg] [-b base_dir]}"; shift
MSG="" BASE="${HERDR_CONTEXT_DIR:-/config/herdr-context}"
while getopts "m:b:" opt; do
  case $opt in
    m) MSG="$OPTARG" ;;
    b) BASE="$OPTARG" ;;
    *) exit 2 ;;
  esac
done

DUMP="$BASE/$SLUG.md"
[ -f "$DUMP" ] || { echo "ERROR: context dump not found: $DUMP — write it before spawning"; exit 1; }

PROJ_DIR="$BASE/$SLUG"
mkdir -p "$PROJ_DIR"
# Per-project CLAUDE.md so the spawned agent auto-inherits the dump from its cwd.
ln -sf "../$SLUG.md" "$PROJ_DIR/CLAUDE.md"

curl -sf -o /dev/null "$T3_URL/" || { echo "ERROR: T3 Code server not reachable at $T3_URL (is the add-on healthy?)"; exit 1; }
# No model is pinned here: the thread gets T3 Code's own default model (Settings ->
# default model, persisted as defaultModelSelection in settings.json), so spawned
# threads follow whatever T3 is set to. thread.create requires a modelSelection, so
# it is read from there rather than omitted.
MODEL_SELECTION=$(jq -ce '.defaultModelSelection // empty' "$T3_HOME/userdata/settings.json" 2>/dev/null) \
  || { echo "ERROR: T3 Code has no default model set — pick one in T3 Code Settings"; exit 1; }

TOK=$(t3 auth session issue --base-dir "$T3_HOME" --ttl 5m --label "spawn-t3:$SLUG" --token-only) \
  || { echo "ERROR: could not mint a T3 bearer token"; exit 1; }
auth=(-H "Authorization: Bearer $TOK" -H "Content-Type: application/json")
uuid() { cat /proc/sys/kernel/random/uuid; }
RPC="$(dirname "$(readlink -f "$0")")/t3-rpc.mjs"

# T3 >= 0.1.0 (Orchestrator V2): projects are plain HTTP (/api/projects[/mutate]);
# thread commands go over the WebSocket RPC (orchestration.dispatchCommand) via
# t3-rpc.mjs. The old HTTP /api/orchestration/dispatch + /snapshot are gone.
dispatch() { # $1 = V2 orchestration command JSON
  node "$RPC" "$T3_URL" "$TOK" orchestration.dispatchCommand "$1" >/dev/null
}

# Resolve (or create) the T3 project for this workspace root.
PROJECT_ID=$(curl -sf "${auth[@]}" "$T3_URL/api/projects" \
  | jq -r --arg root "$PROJ_DIR" '.projects[] | select(.workspaceRoot == $root and .deletedAt == null) | .id' | head -1)
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(uuid)
  curl -sf "${auth[@]}" -X POST "$T3_URL/api/projects/mutate" \
      -d "$(jq -nc --arg cid "$(uuid)" --arg pid "$PROJECT_ID" --arg slug "$SLUG" \
        --arg root "$PROJ_DIR" \
        '{type:"project.create", commandId:$cid, projectId:$pid, title:$slug,
          workspaceRoot:$root}')" >/dev/null \
    || { echo "ERROR: failed to create T3 project '$SLUG'"; exit 1; }
  created_project=1
fi

# Create the thread, then send its first message with start_immediately.
[ -n "$MSG" ] || MSG="You are the dedicated agent for the '$SLUG' project. Your full \
context dump is already loaded as CLAUDE.md (from $DUMP). Read it carefully, confirm \
your understanding of the goal and current state in one short paragraph, then begin \
working on the first next step it lists."
THREAD_ID=$(uuid)
dispatch "$(jq -nc --arg cid "$(uuid)" --arg tid "$THREAD_ID" --arg pid "$PROJECT_ID" \
    --arg slug "$SLUG" --argjson ms "$MODEL_SELECTION" \
    '{type:"thread.create", createdBy:"user", creationSource:"server", commandId:$cid,
      threadId:$tid, projectId:$pid, title:$slug, modelSelection:$ms,
      runtimeMode:"full-access", interactionMode:"default", branch:null, worktreePath:null}')" \
  || { echo "ERROR: failed to create thread"; exit 1; }
dispatch "$(jq -nc --arg cid "$(uuid)" --arg tid "$THREAD_ID" --arg mid "$(uuid)" \
    --arg slug "$SLUG" --arg msg "$MSG" --argjson ms "$MODEL_SELECTION" \
    '{type:"message.dispatch", createdBy:"user", creationSource:"server", commandId:$cid,
      threadId:$tid, messageId:$mid, text:$msg, attachments:[], titleSeed:$slug,
      modelSelection:$ms, dispatchMode:{type:"start_immediately"}}')" \
  || { echo "ERROR: failed to start first turn"; exit 1; }

ENV_ID=$(cat "$T3_HOME/userdata/environment-id")
echo "Spawned project '$SLUG' in T3 Code (HA add-on):"
echo "  project : $PROJECT_ID ($([ -n "${created_project:-}" ] && echo new || echo existing))"
# Derive the label from MODEL_SELECTION so it can never drift from reality again
# (it hardcoded claude-fable-5 and kept printing it after the model changed).
MODEL_NAME="$(printf '%s' "$MODEL_SELECTION" | jq -r .model)"
echo "  thread  : $THREAD_ID  ($MODEL_NAME, cwd $PROJ_DIR, auto-loads CLAUDE.md -> $SLUG.md)"
echo "  dump    : $DUMP"
echo "  url     : $TAILNET_URL/$ENV_ID/$THREAD_ID"
