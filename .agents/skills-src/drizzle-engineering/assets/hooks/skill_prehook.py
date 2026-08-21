#!/usr/bin/env python3
"""
UserPromptSubmit prehook: inject the drizzle-engineering skill.

Loads the skill into the agent's context whenever the user prompt touches
Drizzle ORM work.

Compatible with any harness that runs a command per user prompt and appends
stdout to context (Claude Code UserPromptSubmit, Cursor hooks, Gemini CLI,
generic wrappers). Protocol:

  stdin  : JSON object containing the prompt. Keys probed, in order:
           "prompt" (Claude Code), "user_prompt", "message", "text".
           If stdin is not valid JSON, the raw text is treated as the prompt.
  stdout : text to inject into context (only printed on keyword match).
  exit   : always 0; no-match means silent no-op.

Skill location: defaults to the SKILL.md two directories up from this script
(assets/hooks/ inside the skill folder). Override with the env var
DRIZZLE_ENGINEERING_SKILL_PATH pointing at a SKILL.md.

Set DRIZZLE_ENGINEERING_HOOK_FULL=0 to inject only a short directive telling
the agent to read the skill file, instead of inlining the whole SKILL.md.
"""

import json
import os
import re
import sys

# Drizzle-specific triggers only. Generic database terms (migration, join,
# upsert, N+1, ...) are covered by the sqlite-engineering pre-hook; firing this
# hook on them would inject the full SKILL.md into unrelated database prompts.
TRIGGERS = [
    r"\bdrizzle\b", r"\bdrizzle-orm\b", r"\bdrizzle-kit\b", r"\bdrizzle-zod\b",
    r"\bdrizzle\.config\b",
    r"\bsqliteTable\b", r"\bpgTable\b", r"\bmysqlTable\b",
    r"\bonConflictDo(Update|Nothing)\b",
    r"\bdb\.transaction\b", r"\bdb\.query\b", r"\bdb\.batch\b",
    r"\bsql\.placeholder\b", r"\bsql\.raw\b", r"\bsql\.identifier\b",
    r"\bleftJoin\b", r"\binnerJoin\b",
    r"\bgetTableColumns\b", r"\bbuildConflictUpdateColumns\b",
]

TRIGGER_RE = re.compile("|".join(TRIGGERS), re.IGNORECASE)

DIRECTIVE = (
    "DRIZZLE ORM WORK DETECTED. The drizzle-engineering skill applies to this "
    "task. Follow it: the TypeScript schema is the source of truth, drizzle-kit "
    "generate (never push) for anything shared or production, read every "
    "generated migration before applying it, DDL in generated files and DML "
    "backfills in --custom files, expand-and-contract for destructive changes, "
    "applied migrations are immutable, multi-row mutations stay atomic "
    "(db.transaction where the driver supports it; on drivers that reject SQL "
    "transactions like D1, a single atomic statement or db.batch), and never "
    "sql.raw() on user-controlled input. Pair with "
    "the sqlite-engineering skill for engine-level concerns (STRICT tables, "
    "PRAGMAs, EXPLAIN QUERY PLAN). Full skill:\n\n"
)


def read_prompt() -> str:
    raw = sys.stdin.read()
    if not raw.strip():
        return ""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if isinstance(data, dict):
        for key in ("prompt", "user_prompt", "message", "text"):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                return val
    return ""


def main() -> None:
    prompt = read_prompt()
    if not prompt or not TRIGGER_RE.search(prompt):
        return

    skill_path = os.environ.get(
        "DRIZZLE_ENGINEERING_SKILL_PATH",
        os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "SKILL.md")),
    )

    full = os.environ.get("DRIZZLE_ENGINEERING_HOOK_FULL", "1") != "0"
    if full:
        try:
            with open(skill_path, "r", encoding="utf-8") as fh:
                body = fh.read()
            sys.stdout.write(DIRECTIVE + body + "\n")
            return
        except OSError:
            pass  # fall through to path directive

    refs_dir = os.path.join(os.path.dirname(skill_path), "references")
    sys.stdout.write(
        "DRIZZLE ORM WORK DETECTED. Before proceeding, read the "
        f"drizzle-engineering skill at {skill_path} and follow it. For "
        "migrations/backfills/expand-and-contract, also read "
        f"{os.path.join(refs_dir, 'migrations-workflow.md')}.\n"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Hooks must never break the prompt flow, but silent failure is not
        # acceptable either — log to stderr and still exit 0.
        sys.stderr.write(f"drizzle-engineering prehook failed: {type(exc).__name__}: {exc}\n")
    sys.exit(0)
