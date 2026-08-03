#!/usr/bin/env python3
"""
UserPromptSubmit prehook: inject the mutation-testing skill.

Loads the skill into the agent's context whenever the user prompt touches
mutation testing or test-suite quality verification.

Compatible with any harness that runs a command per user prompt and appends
stdout to context (Claude Code UserPromptSubmit, Cursor hooks, Gemini CLI,
Kimi Code hooks, generic wrappers). Protocol:

  stdin  : JSON object containing the prompt. Keys probed, in order:
           "prompt" (Claude Code), "user_prompt", "message", "text".
           If stdin is not valid JSON, the raw text is treated as the prompt.
  stdout : text to inject into context (only printed on keyword match).
  exit   : always 0; no-match means silent no-op.

Skill location: defaults to the SKILL.md two directories up from this script
(assets/hooks/ inside the skill folder). Override with the env var
MUTATION_TESTING_SKILL_PATH pointing at a SKILL.md.

Set MUTATION_TESTING_HOOK_FULL=0 to inject only a short directive telling
the agent to read the skill file, instead of inlining the whole SKILL.md.
"""

import json
import os
import re
import sys

# Mutation-testing-specific triggers only. Generic test terms (test, spec,
# coverage) are deliberately excluded: firing on them would inject the full
# SKILL.md into every testing prompt. Tune for recall within mutation-testing
# vocabulary, not for testing in general.
TRIGGERS = [
    r"\bmutation test(s|ing)?\b", r"\bmutation score\b",
    r"\bmutation coverage\b", r"\bmutation[- ]feedback\b",
    r"\bmutants?\b", r"\bmutat(e|ed|ing) (the )?(code|source|line)\b",
    r"\bstryker(js|\.net)?\b", r"\bmutmut\b", r"\bpitest\b",
    r"\bcosmic[- ]ray\b", r"\bcargo-mutants\b", r"\bgo-mutesting\b",
    r"\bgremlins\b", r"\binfection php\b", r"\bmuter\b",
    r"\bsurviving (mutant|mutation)s?\b", r"\bkilled mutant",
    r"\bequivalent mutant", r"\btest(-| )suite quality\b",
    r"\bare my tests\b", r"\bweak assertion",
    r"\bdo(es)? (my|the|these) tests? (actually )?(catch|fail)",
]

TRIGGER_RE = re.compile("|".join(TRIGGERS), re.IGNORECASE)

DIRECTIVE = (
    "MUTATION TESTING WORK DETECTED. The mutation-testing skill applies to "
    "this task. Follow it: coverage measures execution, mutation testing "
    "measures whether the suite fails when the code is wrong; never "
    "mutation-test a red suite; scope runs to critical business logic "
    "(changed files for PR-scale work); triage survivors as genuine gap vs "
    "equivalent vs no-coverage; kill a mutant with a behavior test that "
    "passes on the original and fails under the exact mutation — confirm "
    "both directions; ratchet the CI break threshold from the current score, "
    "never jump to 100. Full skill:\n\n"
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
        "MUTATION_TESTING_SKILL_PATH",
        os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "SKILL.md")),
    )

    full = os.environ.get("MUTATION_TESTING_HOOK_FULL", "1") != "0"
    if full:
        try:
            with open(skill_path, "r", encoding="utf-8") as fh:
                body = fh.read()
            sys.stdout.write(DIRECTIVE + body + "\n")
            return
        except OSError as file_error:
            # Fallback must be loud (repo rule): the path directive below
            # degrades gracefully, but the read failure itself is logged.
            sys.stderr.write(
                f"mutation-testing prehook: skill file not readable: "
                f"{skill_path} ({type(file_error).__name__}: {file_error})\n"
            )

    refs_dir = os.path.join(os.path.dirname(skill_path), "references")
    sys.stdout.write(
        "MUTATION TESTING WORK DETECTED. Before proceeding, read the "
        f"mutation-testing skill at {skill_path} and follow it. For survivor "
        "triage, also read "
        f"{os.path.join(refs_dir, 'surviving-mutant-triage.md')}; for tool "
        "setup, "
        f"{os.path.join(refs_dir, 'tools-by-language.md')}.\n"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Hooks must never break the prompt flow, but silent failure is not
        # acceptable either — log to stderr and still exit 0.
        sys.stderr.write(f"mutation-testing prehook failed: {type(exc).__name__}: {exc}\n")
    sys.exit(0)
