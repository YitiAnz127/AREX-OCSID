# MVE prediction with calibration and conformal evaluation

## User Persona
An advanced user who already trained a `regression-mve` Chemprop model and now needs uncertainty-aware prediction. They know the workflows conceptually but want the exact combination of uncertainty/calibration/evaluation/conformal flags and the compatibility rule that the evaluation CSV must carry target labels.

## Scenario Coverage
- Skill area: sub-skill `uncertainty-advanced`
- Capability: prediction-time uncertainty (`MVE` estimator), temperature scaling (`zscaling`) calibration, evaluation methods, conformal coverage, flag/task compatibility
- Difficulty: advanced
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/uncertainty-advanced/SKILL.md`, `references/uncertainty.md`, `references/troubleshooting.md`, `sub-skills/uncertainty-advanced/scripts/chemprop_uncertainty_args.py`
- Trigger expectation: the prompt names `regression-mve`, calibration, evaluation methods, conformal alpha and uncertainty flags — a direct `uncertainty-advanced` trigger.

## Expected Successful Behavior
- Emits a `chemprop predict` command using `--uncertainty-method mve`, `--cal-path calibration.csv`, `--calibration-method zscaling`, and `--evaluation-methods nll-regression miscalibration_area ence spearman`.
- Adds `--conformal-alpha 0.1` with `--calibration-method conformal-regression` for quantile conformal coverage, or explains when the MVE + zscaling path applies.
- Explains that `--evaluation-methods` requires the test/prediction CSV to include target labels matching the model output columns; otherwise both calibration and evaluation cannot be scored.
- Notes `mve` is only valid for `regression-mve`-trained models.
- May recommend the bundled `chemprop_uncertainty_args.py` planner.

## Failure Signals
- Uses `mve` on a plain regression model without explaining the task-type requirement.
- Adds evaluation methods but never flags that the CSV must contain target labels.
- Recommends conformal flags without matching the calibration method.
- Tells the user to inspect the original Chemprop source or tests.
- Omits `--cal-path`, making calibration meaningless.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
