#!/bin/bash
# auto-commit.sh — Stop hook for Claude Code
#
# Stages all changes and commits with an AI-generated message.
# Uses curl + ANTHROPIC_API_KEY directly to avoid calling the `claude` CLI,
# which would trigger the Stop hook recursively.

cd "$CLAUDE_PROJECT_DIR" || exit 1

git add -A

# Nothing staged — exit silently
if git diff --cached --quiet; then
  exit 0
fi

DIFF_STAT=$(git diff --cached --stat)
DIFF_CONTENT=$(git diff --cached -- '*.ts' '*.tsx' '*.py' '*.sql' '*.html' '*.json' | head -200)
FILES=$(git diff --cached --name-only | head -3 | xargs -I{} basename {} | paste -sd ', ')
FALLBACK_MSG="Update $FILES"
COMMIT_MSG=""

if [ -n "$ANTHROPIC_API_KEY" ]; then
  PROMPT="Write a concise git commit message (max 72 chars, imperative mood, no period) summarising these changes. Output only the message, nothing else.

Stat:
$DIFF_STAT

Diff (truncated):
$DIFF_CONTENT"

  PROMPT_JSON=$(printf '%s' "$PROMPT" | python3 -c "
import json, sys
print(json.dumps(sys.stdin.read()))
")

  PAYLOAD="{\"model\":\"claude-haiku-4-5\",\"max_tokens\":100,\"messages\":[{\"role\":\"user\",\"content\":$PROMPT_JSON}]}"

  RESPONSE=$(curl --silent --fail \
    --max-time 30 \
    -X POST https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "$PAYLOAD" 2>/dev/null)

  if [ -n "$RESPONSE" ]; then
    if command -v jq >/dev/null 2>&1; then
      COMMIT_MSG=$(printf '%s' "$RESPONSE" | jq -r '.content[0].text // empty' 2>/dev/null)
    else
      COMMIT_MSG=$(printf '%s' "$RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
try:
    print(data['content'][0]['text'])
except (KeyError, IndexError):
    pass
" 2>/dev/null)
    fi
  fi
fi

if [ -z "$COMMIT_MSG" ]; then
  COMMIT_MSG="$FALLBACK_MSG"
fi

git commit -m "$COMMIT_MSG"
