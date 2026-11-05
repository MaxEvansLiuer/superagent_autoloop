#!/bin/sh
set -eu
if [ "$#" -lt 3 ]; then
  echo '用法：scripts/continue-task.sh <task.continue|review.finding|ci.failed|ci.passed> <task-id> "反馈内容"' >&2
  exit 2
fi
type="$1"
task_id="$2"
shift 2
case "$type" in
  task.continue|review.finding|ci.failed|ci.passed) ;;
  *) echo "不支持的反馈事件类型：$type" >&2; exit 2 ;;
esac
case "$task_id" in
  *[!a-zA-Z0-9._-]*|'') echo 'task-id 只能包含字母、数字、点、下划线和连字符' >&2; exit 2 ;;
esac
event_id="${type}-$(uuidgen | tr -d '-' | cut -c 1-12 | tr '[:upper:]' '[:lower:]')"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
"$ROOT/scripts/agent-autoloop.sh" emit "$type" \
  --id "$event_id" \
  --subject "$task_id" \
  --summary "研发任务收到后续反馈" \
  --detail "$*"
