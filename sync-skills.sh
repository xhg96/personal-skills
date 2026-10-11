#!/usr/bin/env bash
# sync-skills.sh — mirror this repo into each AI tool's skills directory via symlinks
# Usage: ./sync-skills.sh  (idempotent; only prints when something changes)
set -euo pipefail

# Repo path: prefer $PERSONAL_SKILLS_DIR (set by init.sh; path varies per machine),
# fall back to this script's own directory (i.e. the repo itself)
SRC="${PERSONAL_SKILLS_DIR:-$(cd "$(dirname "$0")" && pwd)}"
[[ -d "$SRC" ]] || { echo "error: repo not found: $SRC (check PERSONAL_SKILLS_DIR)" >&2; exit 1; }

DESTS=(
  "$HOME/.claude/skills"
  "$HOME/.codex/skills"
  "$HOME/.agents/skills"
  # project-level example: /path/to/project/.claude/skills
)

for dest in "${DESTS[@]}"; do
  mkdir -p "$dest"

  # remove stale links whose source dir no longer exists
  find "$dest" -maxdepth 1 -type l | while read -r link; do
    n="$(basename "$link")"
    if [[ ! -e "$SRC/$n" ]]; then
      rm -f "$link" && echo "[-] $dest/$n (source removed)"
    fi
  done

  # link every directory containing a SKILL.md
  for d in "$SRC"/*/; do
    n="$(basename "$d")"
    [[ -f "$d/SKILL.md" ]] || continue
    ln -sfn "${d%/}" "$dest/$n"
  done
done

skills=$(find "$SRC" -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')
echo "synced $skills skills to: ${DESTS[*]/#$HOME/~}"
