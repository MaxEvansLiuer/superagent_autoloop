#!/bin/sh
set -eu
project_id=""
if [ "${1:-}" = "--project" ]; then
  if [ "$#" -lt 3 ]; then
    echo '用法：scripts/new-idea.sh [--project <项目编号>] "目标和验收方向"' >&2
    exit 2
  fi
  project_id="$2"
  shift 2
fi
if [ "$#" -lt 1 ]; then
  echo '用法：scripts/new-idea.sh [--project <项目编号>] "目标和验收方向"' >&2
  exit 2
fi
idea="$*"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
project_id="$(node "$ROOT/scripts/projects.mjs" resolve "$project_id")"
id="idea-${project_id}-$(uuidgen | tr -d '-' | cut -c 1-12 | tr '[:upper:]' '[:lower:]')"
"$ROOT/scripts/agent-autoloop.sh" emit "idea.${project_id}.created" \
  --id "$id" \
  --subject "$id" \
  --summary "${IDEA_EVENT_SUMMARY:-提交新的研发点子}" \
  --detail "$idea"
