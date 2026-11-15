#!/usr/bin/env bash
# sync-skills.sh — mirror this repo into each AI tool's skills directory via symlinks,
#                  and link agents-md/AGENTS.md as each tool's global instructions
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
echo "synced $skills skills to:"
printf '  %s\n' "${DESTS[@]/#$HOME/~}"

# --- global agent instructions: link agents-md/AGENTS.md into each tool ---
AGENTS_SRC="$SRC/agents-md/AGENTS.md"
INSTR_DESTS=(
  "$HOME/.claude/CLAUDE.md"   # Claude Code user-level instructions
  "$HOME/.codex/AGENTS.md"    # Codex global instructions
)

linked=()
for dest in "${INSTR_DESTS[@]}"; do
  if [[ ! -f "$AGENTS_SRC" ]]; then
    # source removed: clean up only links that point to it
    if [[ -L "$dest" && "$(readlink "$dest")" == "$AGENTS_SRC" ]]; then
      rm -f "$dest" && echo "[-] $dest (source removed)"
    fi
    continue
  fi

  mkdir -p "$(dirname "$dest")"
  if [[ -L "$dest" ]]; then
    cur="$(readlink "$dest")"
    if [[ "$cur" == "$AGENTS_SRC" ]]; then
      linked+=("$dest")
    elif [[ "$cur" == "$SRC"/* || ! -e "$dest" ]]; then
      # our own stale link, or a broken link: repoint it
      ln -sfn "$AGENTS_SRC" "$dest" && echo "[~] $dest" && linked+=("$dest")
    else
      echo "[!] skipped $dest: symlink to $cur (not managed by this repo)" >&2
    fi
  elif [[ -e "$dest" ]]; then
    # never overwrite a user's own file
    echo "[!] skipped $dest: file already exists — merge or move it aside, then re-run" >&2
  else
    ln -s "$AGENTS_SRC" "$dest" && echo "[+] $dest" && linked+=("$dest")
  fi
done

if (( ${#linked[@]} )); then
  echo "linked AGENTS.md to:"
  printf '  %s\n' "${linked[@]/#$HOME/~}"
fi
