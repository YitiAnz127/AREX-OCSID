# Environment diagnosis and route selection

## User Persona
A user hitting basic environment failures (import missing, blank PNG) and unsure how the root routes to sub-skills. This tests root-level routing, the shared `scripts/check_environment.py` helper, and the shared troubleshooting content rather than any single sub-skill.

## Scenario Coverage
- Skill area: root (`pycirclize`)
- Capability: environment/import/troubleshooting + route dispatch
- Difficulty: troubleshooting
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (Install and smoke-check, Route by task, Cross-route operating rules), `references/troubleshooting.md`, `scripts/check_environment.py`
- Trigger expectation: A request about circular figure setup, import failures, blank output, backend selection, and which route to use triggers the pyCirclize root skill and should route composition/chord work to the proper sub-skills.

## Expected Successful Behavior
- Explains the `ModuleNotFoundError: pycirclize` fix: install into the interpreter that will run the script, verify with `python -c "import pycirclize; print(pycirclize.__version__)"`, and that Bio/numpy/pandas/matplotlib are base runtime deps (ipympl only for tooltips).
- Explains blank PNG cause and the headless fix: `matplotlib.use("Agg")` before importing pyplot / call `plotfig()`/`savefig()` after registering primitives, and verify a non-empty output.
- Routes a general three-sector composition to `circular-composition` and a chord diagram (matrix data) to `data-parsers`.
- Recommends running `python scripts/check_environment.py` as the offline import + tiny render check.

## Failure Signals
- Suggests installing into a different environment than the one running the script, or infers import name from a failed pip elsewhere.
- Treats `ipympl` as required for static plotting.
- Doesn't mention `Agg` for headless rendering.
- Routes the chord/matrix work to composition or plot-primitives instead of data-parsers.
- Doesn't surface the bundled `check_environment.py` helper.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
