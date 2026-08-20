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
MODEL_SELECTION='{"instanceId":"claudeAgent","model":"claude-fable-5","options":[{"id":"effort","value":"high"},{"id":"contextWindow","value":"1m"}]}'

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

TOK=$(t3 auth session issue --base-dir "$T3_HOME" --ttl 5m --label "spawn-t3:$SLUG" --token-only) \
  || { echo "ERROR: could not mint a T3 bearer token"; exit 1; }
auth=(-H "Authorization: Bearer $TOK" -H "Content-Type: application/json")
uuid() { cat /proc/sys/kernel/random/uuid; }
now()  { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

dispatch() { # $1 = command JSON; prints HTTP status, body to stdout on success
  local body status out
  out=$(curl -s -w '\n%{http_code}' "${auth[@]}" -X POST -d "$1" "$T3_URL/api/orchestration/dispatch")
  status=${out##*$'\n'}; body=${out%$'\n'*}
  [ "$status" = 200 ] || { echo "ERROR: dispatch failed (HTTP $status): $body" >&2; return 1; }
  echo "$body"
}

# Resolve (or create) the T3 project for this workspace root.
PROJECT_ID=$(curl -sf "${auth[@]}" "$T3_URL/api/orchestration/snapshot" \
  | jq -r --arg root "$PROJ_DIR" '.projects[] | select(.workspaceRoot == $root and .deletedAt == null) | .id' | head -1)
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(uuid)
  dispatch "$(jq -nc --arg cid "$(uuid)" --arg pid "$PROJECT_ID" --arg slug "$SLUG" \
      --arg root "$PROJ_DIR" --arg at "$(now)" --argjson ms "$MODEL_SELECTION" \
      '{type:"project.create", commandId:$cid, projectId:$pid, title:$slug,
        workspaceRoot:$root, defaultModelSelection:$ms, createdAt:$at}')" >/dev/null \
    || { echo "ERROR: failed to create T3 project '$SLUG'"; exit 1; }
  created_project=1
fi

# Create the thread, then kick off its first turn. (The HTTP dispatch path does
# not honor bootstrap.createThread on thread.turn.start, so two dispatches.)
[ -n "$MSG" ] || MSG="You are the dedicated agent for the '$SLUG' project. Your full \
context dump is already loaded as CLAUDE.md (from $DUMP). Read it carefully, confirm \
your understanding of the goal and current state in one short paragraph, then begin \
working on the first next step it lists."
THREAD_ID=$(uuid)
dispatch "$(jq -nc --arg cid "$(uuid)" --arg tid "$THREAD_ID" --arg pid "$PROJECT_ID" \
    --arg slug "$SLUG" --arg at "$(now)" --argjson ms "$MODEL_SELECTION" \
    '{type:"thread.create", commandId:$cid, threadId:$tid, projectId:$pid,
      title:$slug, modelSelection:$ms, runtimeMode:"full-access",
      interactionMode:"default", branch:null, worktreePath:null, createdAt:$at}')" >/dev/null \
  || { echo "ERROR: failed to create thread"; exit 1; }
dispatch "$(jq -nc --arg cid "$(uuid)" --arg tid "$THREAD_ID" \
    --arg slug "$SLUG" --arg mid "$(uuid)" --arg msg "$MSG" --arg at "$(now)" \
    --argjson ms "$MODEL_SELECTION" \
    '{type:"thread.turn.start", commandId:$cid, threadId:$tid,
      message:{messageId:$mid, role:"user", text:$msg, attachments:[]},
      modelSelection:$ms, titleSeed:$slug, runtimeMode:"full-access",
      interactionMode:"default", createdAt:$at}')" >/dev/null \
  || { echo "ERROR: failed to start first turn"; exit 1; }

ENV_ID=$(cat "$T3_HOME/userdata/environment-id")
echo "Spawned project '$SLUG' in T3 Code (HA add-on):"
echo "  project : $PROJECT_ID ($([ -n "${created_project:-}" ] && echo new || echo existing))"
echo "  thread  : $THREAD_ID  (claude-fable-5, cwd $PROJ_DIR, auto-loads CLAUDE.md -> $SLUG.md)"
echo "  dump    : $DUMP"
echo "  url     : $TAILNET_URL/$ENV_ID/$THREAD_ID"
