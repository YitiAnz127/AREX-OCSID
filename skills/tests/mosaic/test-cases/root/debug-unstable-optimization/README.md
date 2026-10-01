# Debug failing designs, unstable optimization, and OOM

## User Persona
A user mid-project who has hit several of Mosaic's documented failure modes at
once. They know Mosaic's structure but need the focused recovery guidance for
objective quality, optimizer stability, JIT cost, and GPU memory pressure.

## Scenario Coverage
- Skill area: root (`mosaic`)
- Capability: troubleshooting under-constrained objectives, unstable `simplex_APGM`, JIT slowness, and predictor OOM
- Difficulty: troubleshooting
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (Troubleshooting table, core idea)
- Trigger expectation: The prompt describes the exact failure modes in the
  SKILL.md troubleshooting table (designs fail in-silico checks, unstable
  optimization, first call JIT slow, OOM with large predictors).

## Expected Successful Behavior
- Routes to `mosaic` and matches each symptom to the SKILL.md troubleshooting row:
  - designs fail simple checks -> under-constrained objective -> add inverse-folding
    and confidence terms, filter with `protein-qc`;
  - unstable optimization -> step size too large -> lower the `simplex_APGM` step size;
  - first call very slow -> JIT compilation -> reuse the compiled loss across designs;
  - OOM with large predictors -> several models in one loss -> use smaller predictors
    or a larger GPU.
- Suggests validating designs with `boltz`/`chai`, ranking with `ipsae`, and
  filtering with `protein-qc` (the SKILL.md "Next" handoff).

## Failure Signals
- Ignores the objective/confidence diagnosis and only tweaks random hyperparameters.
- Blames "a bug in Mosaic" without checking the documented causes.
- Recommends raising the step size when optimization is unstable.
- Suggests downloading more large models instead of reducing predictor size on OOM.
- Points to the original escalante-bio/mosaic checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
