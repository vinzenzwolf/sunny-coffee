#!/bin/bash
set -e

cd "$CLAUDE_PROJECT_DIR"

git add -A

# Nothing staged — exit silently
if git diff --cached --quiet; then exit 0; fi

# Capture staged state immediately, then commit+push in background
DIFF_STAT=$(git diff --cached --stat)
DIFF_CONTENT=$(git diff --cached -- '*.ts' '*.tsx' '*.py' '*.sql' '*.html' '*.json' | head -200)

(
  MSG=$(claude --model claude-haiku-4-5-20251001 -p "Write a concise git commit message (max 72 chars, imperative mood, no period) summarising these changes. Output only the message, nothing else.

Stat:
$DIFF_STAT

Diff (truncated):
$DIFF_CONTENT" 2>/dev/null)

  if [ -z "$MSG" ]; then
    FILES=$(git diff --cached --name-only | head -3 | xargs -I{} basename {} | paste -sd ', ')
    MSG="Update $FILES"
  fi

  git commit -m "$MSG"
  git push
) &
disown
