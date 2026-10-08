#!/usr/bin/env python3
"""Validate benchmark usability-case artifacts against the honesty contract.

Walks `skills/tests/<skill-id>/test-cases/` and, for every `assertions.json`:
  - verifies the required ocsid.usability-case.v1 fields are present and valid,
  - verifies every `evidence_basis` path actually exists under
    `skills/repositories/repo-skills/<skill-id>/`,
  - verifies every `expected_skill_files` path actually exists inside the
    generated skill directory,
  - requires the case directory to contain user_request.txt + README.md.

This is a *read-only* checker: it reports problems and exits non-zero, never
writes. Use it to stop fabricated (non-existent-file) assertions from entering
the frozen benchmark.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TESTS = os.path.join(ROOT, "skills", "tests")
REPO = os.path.join(ROOT, "skills", "repositories", "repo-skills")

REQUIRED = {"schema", "target_skill_area", "target_capability", "difficulty", "evidence_basis", "expected_skill_files", "assertions"}
VALID_DIFFICULTY = {"basic", "intermediate", "advanced", "troubleshooting"}

problems = []
checked = 0


def check(cond, message):
    global checked
    checked += 1
    if not cond:
        problems.append(message)


def validate_case(case_dir, skill_id):
    aj = os.path.join(case_dir, "assertions.json")
    ur = os.path.join(case_dir, "user_request.txt")
    rm = os.path.join(case_dir, "README.md")
    rel = os.path.relpath(case_dir, TESTS)
    check(os.path.isfile(ur), f"{rel}: missing user_request.txt")
    check(os.path.isfile(rm), f"{rel}: missing README.md")
    if not os.path.isfile(aj):
        check(False, f"{rel}: missing assertions.json")
        return
    try:
        data = json.load(open(aj, encoding="utf-8"))
    except (OSError, ValueError) as exc:
        check(False, f"{rel}: assertions.json unreadable/invalid: {exc}")
        return
    for field in REQUIRED:
        check(field in data, f"{rel}: assertions.json missing field {field!r}")
    check(data.get("schema") == "ocsid.usability-case.v1", f"{rel}: schema != ocsid.usability-case.v1")
    check(data.get("difficulty") in VALID_DIFFICULTY, f"{rel}: difficulty {data.get('difficulty')!r} invalid")
    check(isinstance(data.get("assertions"), list) and len(data["assertions"]) > 0,
          f"{rel}: assertions must be a non-empty list")
    # evidence_basis must resolve inside the source skill for that skill id.
    skill_root = os.path.join(REPO, skill_id)
    for ev in data.get("evidence_basis", []):
        if not isinstance(ev, str) or not ev:
            check(False, f"{rel}: evidence_basis entry not a path string")
            continue
        target = os.path.normpath(os.path.join(skill_root, ev))
        check(os.path.isfile(target) and os.path.realpath(target).startswith(os.path.realpath(skill_root)),
              f"{rel}: evidence_basis {ev!r} does not exist in skill {skill_id}")
    for ef in data.get("expected_skill_files", []):
        if not isinstance(ef, str) or not ef:
            check(False, f"{rel}: expected_skill_files entry not a path string")
            continue
        target = os.path.normpath(os.path.join(skill_root, ef))
        check(os.path.isfile(target) and os.path.realpath(target).startswith(os.path.realpath(skill_root)),
              f"{rel}: expected_skill_files {ef!r} does not exist in skill {skill_id}")


def main():
    if not os.path.isdir(TESTS):
        print("no skills/tests directory yet", file=sys.stderr)
        return 0
    case_count = 0
    for skill_id in sorted(os.listdir(TESTS)):
        cases_root = os.path.join(TESTS, skill_id, "test-cases")
        if not os.path.isdir(cases_root):
            continue
        for root, dirs, files in os.walk(cases_root):
            # only validate leaves that hold an assertions.json
            if "assertions.json" in files and os.path.basename(root).count(os.sep) >= 0:
                case_count += 1
                validate_case(root, skill_id)
    print(f"validated {case_count} case dir(s); {checked} checks; {len(problems)} problem(s)")
    for p in problems:
        print(f"  PROBLEM: {p}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
