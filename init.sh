#!/usr/bin/env bash
# init.sh — register this repo as $PERSONAL_SKILLS_DIR in the shell rc file
# Usage: ./init.sh  (idempotent; reopen the terminal or `source` the rc file to apply)
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$REPO/sync-skills.sh" ]] || { echo "error: $REPO is not a skills repo (sync-skills.sh not found)" >&2; exit 1; }

case "$(basename "${SHELL:-/bin/zsh}")" in
  zsh)  RC="$HOME/.zshrc" ;;
  bash) RC="$HOME/.bashrc" ;;
  *)    RC="$HOME/.profile" ;;
esac
touch "$RC"

LINE="export PERSONAL_SKILLS_DIR=\"$REPO\""
if grep -q "^export PERSONAL_SKILLS_DIR=" "$RC"; then
  if grep -qF "$LINE" "$RC"; then
    echo "already configured in $RC"
  else
    sed -i.bak '/^export PERSONAL_SKILLS_DIR=/d' "$RC" && rm -f "$RC.bak"
    echo "$LINE" >> "$RC"
    echo "updated $RC: $LINE"
  fi
else
  { echo ""; echo "# personal skills repo (managed by init.sh)"; echo "$LINE"; } >> "$RC"
  echo "added to $RC: $LINE"
fi
