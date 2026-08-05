#!/usr/bin/env python3
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
"""
UserPromptSubmit prehook: inject the mutation-testing skill.

Loads the skill into the agent's context whenever the user prompt touches
mutation testing or test-suite quality verification.

Compatible with any harness that runs a command per user prompt and appends
stdout to context (Claude Code UserPromptSubmit, Cursor hooks, Gemini CLI,
Kimi Code hooks, generic wrappers). Protocol:

  stdin  : JSON object containing the prompt. Keys probed, in order:
           "prompt" (Claude Code), "user_prompt", "message", "text".
           A bare JSON string literal is used directly; if stdin is not
           valid JSON, the raw text is treated as the prompt.
  stdout : text to inject into context. Printed on keyword match; a loud
           WARNING line is also printed on hook failure — fallbacks must be
           visible to the user (stdout), not only logged (stderr).
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
# SKILL.md into every testing prompt. "Mutant(s)" must appear in a
# mutation-testing phrase (surviving/killed/equivalent/kill) — the bare word
# also matches fiction and film prompts. Tune for recall within
# mutation-testing vocabulary, not for testing in general.
TRIGGERS = [
    r"\bmutation test(s|ing)?\b", r"\bmutation score\b",
    r"\bmutation coverage\b", r"\bmutation[- ]feedback\b",
    r"\bmutat(e|ed|ing) (the )?(code|source|line)\b",
    r"\bstryker(js|\.net)?\b", r"\bmutmut\b", r"\bpitest\b",
    r"\bcosmic[- ]ray\b", r"\bcargo-mutants\b", r"\bgo-mutesting\b",
    r"\binfection php\b", r"\bmuter\b",
    r"\bsurviving (mutant|mutation)s?\b", r"\bkilled mutants?\b",
    r"\bequivalent mutants?\b", r"\bkill(ing)? (the |those |these |that )?mutants?\b",
    r"\btest(-| )suite quality\b",
    r"\b(is|are) my tests? (actually )?(good|catching|enough|worth|strong)\b", r"\bweak assertions?\b",
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
    if isinstance(data, str):
        # Valid JSON string literal (e.g. harness pre-encodes the prompt).
        return data
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
            # Fallback must be loud (repo rule): log server-side AND show the
            # failure to the user — in stdout-injecting harnesses stderr may
            # never be seen, so the warning goes to both channels.
            sys.stderr.write(
                f"mutation-testing prehook: skill file not readable: "
                f"{skill_path} ({type(file_error).__name__}: {file_error})\n"
            )
            sys.stdout.write(
                f"[mutation-testing prehook WARNING: could not read the skill "
                f"file at {skill_path} ({type(file_error).__name__}: {file_error}); "
                "falling back to a path directive.]\n"
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
        # Hooks must never break the prompt flow, but failure must be loud on
        # both channels: stderr for the server log, stdout so the user (and
        # the agent reading injected context) actually sees it. Each write is
        # guarded: when the original error came from a broken output stream,
        # writing to that stream raises again, and an unguarded handler would
        # exit non-zero, breaking the always-exit-0 contract.
        try:
            sys.stderr.write(f"mutation-testing prehook failed: {type(exc).__name__}: {exc}\n")
        except Exception:
            pass
        try:
            sys.stdout.write(
                f"[mutation-testing prehook WARNING: hook failed: {type(exc).__name__}: {exc}]\n"
            )
        except Exception:
            pass
    sys.exit(0)
