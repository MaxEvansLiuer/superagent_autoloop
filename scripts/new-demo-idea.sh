#!/bin/sh
set -eu
if [ "$#" -lt 1 ]; then
  echo '用法：scripts/new-demo-idea.sh "你想做什么"' >&2
  exit 2
fi
idea="$*"
id="idea-$(uuidgen | tr -d '-' | cut -c 1-12 | tr '[:upper:]' '[:lower:]')"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
"$ROOT/scripts/agent-autoloop.sh" emit idea.created \
  --id "$id" \
  --subject "$id" \
  --summary "新研发点子已提交" \
  --detail "$idea"
