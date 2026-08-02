#!/usr/bin/env python3
"""UserPromptSubmit prehook: inject the sqlite-engineering skill into the
agent's context whenever the user prompt touches database work.

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
SQLITE_ENGINEERING_SKILL_PATH pointing at a SKILL.md.

Set SQLITE_ENGINEERING_HOOK_FULL=0 to inject only a short directive telling
the agent to read the skill file, instead of inlining the whole SKILL.md.
"""

import json
import os
import re
import sys

TRIGGERS = [
    r"\bsqlite3?\b", r"\blibsql\b", r"\bturso\b", r"\bbetter-sqlite3\b",
    r"\bcloudflare\s+d1\b", r"\bd1\s+database\b",
    r"\bdrizzle\b", r"\bdrizzle-kit\b",
    r"\bdatabase\b", r"\bdb\s+schema\b", r"\bschema\s+design\b",
    r"\bmigration(s)?\b", r"\bbackfill(s|ing)?\b",
    r"\bsql\b", r"\bselect\s+.+\s+from\b", r"\bcreate\s+table\b",
    r"\balter\s+table\b", r"\bindex(es)?\b", r"\bforeign\s+key(s)?\b",
    r"\bwal\s+mode\b", r"\bpragma\b", r"\bexplain\s+query\s+plan\b",
    r"\bsqlite_busy\b", r"\bbusy_timeout\b", r"\bjournal_mode\b",
    r"\bfts5\b", r"\bjson_extract\b", r"\bvacuum\b",
    r"\bquery\s+(plan|tuning|optimization|perf)\b",
    r"\bslow\s+quer", r"\bn\+1\b",
    r"\bnormali[sz](e|ation|ed)\b",
]

TRIGGER_RE = re.compile("|".join(TRIGGERS), re.IGNORECASE)

DIRECTIVE = (
    "DATABASE WORK DETECTED. The sqlite-engineering skill applies to this "
    "task. Follow it: STRICT tables, per-connection PRAGMAs (foreign_keys=ON, "
    "busy_timeout), forward-only migrations, EXPLAIN QUERY PLAN on every new "
    "query shape, index to match, verification against the real schema - not "
    "tool exit codes - and deliberate ordering of external side effects vs "
    "transactions. Full skill:\n\n"
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
        "SQLITE_ENGINEERING_SKILL_PATH",
        os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "SKILL.md")),
    )

    full = os.environ.get("SQLITE_ENGINEERING_HOOK_FULL", "1") != "0"
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
        "DATABASE WORK DETECTED. Before proceeding, read the sqlite-engineering "
        f"skill at {skill_path} and follow it. For migrations/backfills/cron "
        f"sweeps/mixed API+transaction flows, also read {os.path.join(refs_dir, 'field-failures.md')}.\n"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # hooks must never break the prompt flow
    sys.exit(0)
