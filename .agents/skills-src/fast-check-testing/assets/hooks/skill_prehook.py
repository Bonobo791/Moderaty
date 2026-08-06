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
UserPromptSubmit prehook: inject the fast-check-testing skill.

Loads the skill into the agent's context whenever the user prompt touches
property-based testing, fast-check, or generative/invariant testing.

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
FAST_CHECK_TESTING_SKILL_PATH pointing at a SKILL.md.

Set FAST_CHECK_TESTING_HOOK_FULL=0 to inject only a short directive telling
the agent to read the skill file, instead of inlining the whole SKILL.md.
"""

import json
import os
import re
import sys

# Property-based-testing-specific triggers only. Generic test terms (test,
# spec, coverage, unit) are deliberately excluded: firing on them would
# inject the full SKILL.md into every testing prompt. "Shrink" and
# "counterexample" must appear in a testing phrase — the bare words also
# match math and everyday prompts. Tune for recall within PBT vocabulary,
# not for testing in general.
TRIGGERS = [
    r"\bfast[- ]?check\b",
    r"\bproperty[- ]based test(s|ing)?\b", r"\bproperty tests?\b",
    r"\bPBT\b",
    r"\barbitrar(y|ies)\b",
    r"\bfc\.(assert|property|asyncProperty|commands|scheduler|pre)\b",
    r"\bshrink(s|ing|er)? (the |a |to a )?(counterexample|failure|failing input)\b",
    r"\bcounterexample(s)? (to|into|as) (a |an )?(regression|example|test)\b",
    r"\bseed (replay|and path)\b", r"\breplay (the |a )?(failed )?seed\b",
    r"\bmodel[- ]based test(s|ing)?\b",
    r"\brace condition tests?\b",
    r"\binvariant test(s|ing)?\b", r"\bmetamorphic test(s|ing)?\b",
    r"\bgenerative test(s|ing)?\b", r"\bfuzz test(s|ing)?\b",
    r"\bquickcheck\b",
]

TRIGGER_RE = re.compile("|".join(TRIGGERS), re.IGNORECASE)

DIRECTIVE = (
    "PROPERTY-BASED TESTING WORK DETECTED. The fast-check-testing skill "
    "applies to this task. Follow it: find the property, not the input — "
    "assert relationships (round-trip, idempotence, isolation, "
    "conservation), never implementation details; constrain arbitraries by "
    "construction (parameters/map/chain), not .filter/fc.pre rejection; a "
    "property that cannot fail is worse than no property — sanity-check it "
    "goes red under a deliberate break; every failure prints seed/path for "
    "exact replay — convert counterexamples into examples: entries or "
    "standalone regression tests; keep example tests and mutation testing — "
    "properties complement them, never replace them. Full skill:\n\n"
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
        "FAST_CHECK_TESTING_SKILL_PATH",
        os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "SKILL.md")),
    )

    full = os.environ.get("FAST_CHECK_TESTING_HOOK_FULL", "1") != "0"
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
                f"fast-check-testing prehook: skill file not readable: "
                f"{skill_path} ({type(file_error).__name__}: {file_error})\n"
            )
            sys.stdout.write(
                f"[fast-check-testing prehook WARNING: could not read the skill "
                f"file at {skill_path} ({type(file_error).__name__}: {file_error}); "
                "falling back to a path directive.]\n"
            )

    refs_dir = os.path.join(os.path.dirname(skill_path), "references")
    sys.stdout.write(
        "PROPERTY-BASED TESTING WORK DETECTED. Before proceeding, read the "
        f"fast-check-testing skill at {skill_path} and follow it. For "
        "finding the property, also read "
        f"{os.path.join(refs_dir, 'property-patterns.md')}; for building "
        "generators, "
        f"{os.path.join(refs_dir, 'arbitraries-cookbook.md')}.\n"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Hooks must never break the prompt flow, but failure must be loud on
        # both channels: stderr for the server log, stdout so the user (and
        # the agent reading injected context) actually sees it. When a write
        # fails the harness's swapped-in stream is dead, so fall back to the
        # interpreter's original stream AND reassign sys.stderr/sys.stdout to
        # it — otherwise interpreter shutdown flushes the dead object and the
        # process exits 120 despite sys.exit(0). Only a double failure is
        # swallowed: with no channel left there is nothing to write to, and
        # the always-exit-0 contract still holds.
        err_msg = f"fast-check-testing prehook failed: {type(exc).__name__}: {exc}\n"
        try:
            sys.stderr.write(err_msg)
        except Exception:
            sys.stderr = sys.__stderr__
            try:
                sys.stderr.write(err_msg)
            except Exception:
                pass
        warn_msg = f"[fast-check-testing prehook WARNING: hook failed: {type(exc).__name__}: {exc}]\n"
        try:
            sys.stdout.write(warn_msg)
        except Exception:
            sys.stdout = sys.__stdout__
            try:
                sys.stdout.write(warn_msg)
            except Exception:
                pass
    sys.exit(0)
