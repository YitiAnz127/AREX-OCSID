# Diagnose a gget install/version mismatch

## User Persona
A user (novice-to-intermediate) hitting installation/version confusion after
installing gget in a fresh environment. They suspect a shadowed executable or an
interpreter mismatch and have not installed the optional `cellxgene` extra yet.
They want a safe, read-only diagnostic and clear environment rules.

## Scenario Coverage
- Skill area: root (`gget`)
- Capability: read-only install/import/CLI diagnostic via `scripts/check_install.py` plus environment rules
- Difficulty: troubleshooting
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (Install and inspect first, shared
  recovery), `references/troubleshooting.md`, `scripts/check_install.py`
- Trigger expectation: The prompt is about gget installation, import, version,
  and CLI check — routed at the root because it precedes any sub-skill-appropriate
  query; the root SKILL.md directs a fresh install/CLI inspection first.

## Expected Successful Behavior
- Routes at root and runs `python scripts/check_install.py` for a read-only
  interpreter, distribution-version, import, and CLI version/help summary.
- Uses the same interpreter for `python -m pip show gget`,
  `python -c "import gget; print(gget.__version__)"`, and `gget --version`.
- Recommends a fresh Python 3.12+ environment and checking `command -v gget` for
  a shadowing executable, per troubleshooting.md.
- Concludes `gget[cellxgene]` is installed only when a CELLxGENE Census query is
  selected.

## Failure Signals
- Calls a remote database or runs `--download`/`setup` during a pure diagnostic.
- Mixes interpreters or ignores a shadowed `gget` executable.
- Installs `gget[cellxgene]` or runs `gget setup <module>` unprompted.
- Points at the original gget source repository checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
