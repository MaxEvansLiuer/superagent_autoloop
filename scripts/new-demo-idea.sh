#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
IDEA_EVENT_SUMMARY="新研发点子已提交" exec "$ROOT/scripts/new-idea.sh" "$@"
