---
name: personal-skill
description: Create, update, or remove skills in the local personal skills repo and sync them into the skills directories of AI tools (Claude Code, Kimi Code, Cursor, Copilot, Codex, etc.). Use when the user asks to create a new skill, modify or delete an existing one, or asks where skills live or why one is not loading.
---

# Managing Personal Skills

## Repo Location

The skills repo path is given by the `PERSONAL_SKILLS_DIR` environment variable. **The path differs per machine — never hardcode an absolute path.**

- Run `./init.sh` inside the repo on a new machine: it detects the repo location from its own path and writes `export PERSONAL_SKILLS_DIR="<repo>"` into the shell rc file (`~/.zshrc`, `~/.bashrc`, or `~/.profile`).
- Without the variable, `sync-skills.sh` falls back to its own directory as the repo root.

Repo layout: each skill is a directory at the repo root containing a `SKILL.md`; the root also holds `init.sh` and `sync-skills.sh`.

## SKILL.md Requirements

- YAML frontmatter with at least `name` and `description`.
- `name` must match the directory name (lowercase letters, digits, hyphens).
- `description` should say what it does **and when to use it** — agents rely on it to decide when to trigger the skill.
- Body is Markdown; optional `scripts/`, `references/`, `assets/` subdirectories are referenced by relative paths.

## Create / Update / Remove

1. Create, edit, or delete `<skill-name>/SKILL.md` under `$PERSONAL_SKILLS_DIR/`. Use the `skill-creator` skill when authoring a new one.
2. Sync (idempotent): `bash "$PERSONAL_SKILLS_DIR/sync-skills.sh"`
3. Syncing symlinks every directory containing a `SKILL.md` into:
   - `~/.claude/skills` — Claude Code (scans only this one level; links are flattened per skill)
   - `~/.codex/skills` — Codex compatibility path
   - `~/.agents/skills` — cross-client convention read by Kimi Code, Cursor, VS Code Copilot, OpenCode, Gemini CLI, etc.
4. Verify with `ls -l ~/.agents/skills/<skill-name>` (should point into the repo), then **start a new session** — most tools scan skills only at startup.

## Notes

- Syncing is by symlink: editing repo files takes effect everywhere with no re-sync needed. Re-run sync only after adding or removing skill directories.
- Removing a skill: delete its source directory, re-run sync, and the script cleans up the stale links automatically.
- Files without a `SKILL.md` (notes, scripts) are skipped by sync and can live in the repo freely.
- If a skill is not loading: check `$PERSONAL_SKILLS_DIR` is set and correct, re-run sync, confirm the symlink exists, and open a new session.
