#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export AGENT_AUTOLOOP_HOME="$ROOT/.local/agent-autoloop"
export CODEX_HOME="${CODEX_HOME:-/Users/liuboshan/.codex}"
export IDEA_DELIVERY_HOME="$ROOT"
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
exec "$AGENT_AUTOLOOP_HOME/app/bin/agent-autoloop.ts" "$@"
