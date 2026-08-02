# Auto-Injecting This Skill via a Prehook

Skills normally load only when the agent decides to read them. `assets/hooks/skill_prehook.py` makes loading deterministic: it runs on every user prompt, keyword-matches database work, and prints the skill to stdout for the harness to append to context. No match → silent no-op, zero context cost.

Contents: how it works · Claude Code · Cursor · generic harnesses · tuning

## How it works

- Input: JSON on stdin with the prompt (`prompt` / `user_prompt` / `message` / `text` keys probed; raw text accepted as fallback).
- Output: the full SKILL.md inlined into context (default), or a short "read this file" directive when `SQLITE_ENGINEERING_HOOK_FULL=0`.
- Trigger list covers: sqlite/libsql/turso/drizzle/D1, migration, backfill, schema, index, foreign key, WAL/pragma/journal_mode, EXPLAIN QUERY PLAN, FTS5, vacuum, slow query, N+1, normalization, generic `sql`/`database`.
- Always exits 0 and never throws — a hook failure must never break the prompt flow.
- Locates SKILL.md relative to itself (`assets/hooks/` → two dirs up). Override with env `SQLITE_ENGINEERING_SKILL_PATH=/path/to/SKILL.md` if the script is copied out of the skill folder.

## Claude Code

`.claude/settings.json` (project) or `~/.claude/settings.json` (global):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /path/to/sqlite-engineering/assets/hooks/skill_prehook.py"
          }
        ]
      }
    ]
  }
}
```

Claude Code pipes hook JSON (including `prompt`) to stdin and appends stdout to the conversation context. Test: `echo '{"prompt":"add a drizzle migration"}' | python3 skill_prehook.py` should print the skill; `echo '{"prompt":"fix the navbar"}' | python3 skill_prehook.py` should print nothing.

## Cursor

Cursor supports agent hooks via `hooks.json` (project: `.cursor/hooks.json`, or user settings). Register the same command under the prompt-submit hook event; the script's stdin/stdout contract is identical. If a given Cursor version only supports lifecycle events without prompt injection, use the `SQLITE_ENGINEERING_HOOK_FULL=0` mode and put the skill path in `.cursor/rules` as a fallback:

```
---
description: SQLite engineering rules
globs: **/*.sql, **/drizzle/**, **/migrations/**
alwaysApply: false
---
Read and follow ~/.skills/sqlite-engineering/SKILL.md before any database work.
```

## Generic / other harnesses

Any runner that can execute a command per prompt and prepend stdout works:

```bash
inject=$(echo "$PROMPT_JSON" | python3 /path/to/skill_prehook.py)
final_prompt="${inject}${inject:+$'\n\n---\n\n'}${PROMPT}"
```

For MCP-based agents without prompt hooks, alternative: expose the skill as an MCP `resource` or a one-line system-prompt addition ("Before any database/schema/migration/SQL work, read and follow <path>/SKILL.md").

## Tuning

- **Context budget**: `SQLITE_ENGINEERING_HOOK_FULL=0` injects ~60 words pointing at the files instead of ~800 words of SKILL.md. Prefer full injection when the agent can't be trusted to read files.
- **Trigger breadth**: edit `TRIGGERS` in the script. Removing `\bsql\b` and `\bdatabase\b` cuts false positives on prose prompts; keeping them maximizes recall.
- **False-positive cost is low**: worst case is ~800 extra tokens on a non-DB prompt. Missing a real DB prompt is the expensive direction — tune for recall.
