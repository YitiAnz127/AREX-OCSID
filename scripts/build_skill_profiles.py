#!/usr/bin/env python3
"""Emit deterministic skill profiles for the Pilot benchmark (Step 2).

Reads the 109 repository repo-skills and classifies each into a content-derived
category, purely from physical structure (never from routing confidence or any
subjective signal):

    executable  - has a root `scripts/` directory (runnable env/validation scripts)
    workflow    - no root scripts, but has `sub-skills/` (multi-step orchestration)
    reference   - neither (doc/reference-only)

This is a *read-only emission* script: it never writes into the skills tree.
It feeds the deterministic selection in
cli/packages/coding-agent/src/benchmark/pilot.ts so the frozen benchmark split
has a stable, evidence-based profile per skill.

Usage:
    python scripts/build_skill_profiles.py                # print JSON to stdout
    python scripts/build_skill_profiles.py -o PATH        # write JSON to PATH
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS = os.path.join(ROOT, "skills", "repositories", "repo-skills")


def category_for(skill_dir: str) -> str:
    has_scripts = os.path.isdir(os.path.join(skill_dir, "scripts"))
    has_sub_skills = os.path.isdir(os.path.join(skill_dir, "sub-skills"))
    if has_scripts:
        return "executable"
    if has_sub_skills:
        return "workflow"
    return "reference"


def main() -> None:
    if not os.path.isdir(SKILLS):
        raise SystemExit(f"repo-skills root does not exist: {SKILLS}")
    profiles = []
    for name in sorted(os.listdir(SKILLS)):
        dp = os.path.join(SKILLS, name)
        if not os.path.isdir(dp):
            continue
        md = os.path.join(dp, "references", "repo-routing-metadata.json")
        if not os.path.isfile(md):
            continue
        try:
            with open(md, encoding="utf-8") as fh:
                meta = json.load(fh)
        except (OSError, ValueError):
            continue
        if meta.get("routing_status") != "classified":
            continue
        profiles.append({"skillId": name, "category": category_for(dp)})

    out = {"skillCount": len(profiles), "profiles": profiles}
    if "-o" in sys.argv:
        try:
            path = sys.argv[sys.argv.index("-o") + 1]
        except IndexError as exc:
            raise SystemExit("-o requires a path") from exc
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
        print(f"wrote {len(profiles)} profiles to {path}")
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
