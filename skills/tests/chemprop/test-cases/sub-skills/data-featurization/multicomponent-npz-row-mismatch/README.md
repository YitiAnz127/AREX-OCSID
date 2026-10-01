# Multicomponent descriptor NPZ row-count mismatch

## User Persona
A user who knows how to write a basic Chemprop command but is hitting a data-shape failure with component-indexed descriptor `.npz` files. They are in a support/debugging workflow and want a concrete preflight command plus the row-count rule.

## Scenario Coverage
- Skill area: sub-skill `data-featurization`
- Capability: component-indexed descriptor `.npz` validation, CSV/NPZ row-count alignment, preflight via the bundled validator
- Difficulty: troubleshooting
- Prompt file: `user_request.txt`
- Fixtures: `fixtures/multicomponent.csv` (small solute/solvent/target CSV)
- Expected references/scripts: `sub-skills/data-featurization/SKILL.md`, `references/extra-features-descriptors.md`, `references/troubleshooting.md`, `sub-skills/data-featurization/scripts/validate_chemprop_tabular_inputs.py`
- Trigger expectation: the prompt names SMILES columns, per-component `.npz` descriptors and a row-count mismatch — a direct `data-featurization` trigger.

## Expected Successful Behavior
- Routes to `data-featurization`.
- Explains component-indexed descriptor paths map component index `0` to the first molecule column (solute) and `1` to the second (solvent).
- Runs/recommends `validate_chemprop_tabular_inputs.py --csv multicomponent.csv --smiles-columns solute solvent --component-descriptors 0 solute_descriptors.npz --component-descriptors 1 solvent_descriptors.npz`.
- States that the row-level descriptor matrix must have exactly one row per CSV data row (`n_rows x n_descriptors`), and that a solute file with one fewer row will fail the row-count check.
- Notes that atom/bond matrices must match per-molecule atom/bond counts, but row-level descriptors are global to the datapoint row.
- Does not suggest opening the original repo.

## Failure Signals
- Uses `--descriptors-path` (global row-level) for a per-component descriptor file instead of component-indexed paths.
- Fails to mention the validator or its `--component-descriptors` repeatable flag.
- Claims atom/bond ordering is global when it is per-row.
- Gives generic "check your CSV" advice without the row-count rule.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.

## Fixture note
`fixtures/multicomponent.csv` is a 4-row solute/solvent/target CSV used to make the prompt concrete; the solver descriptor `.npz` is intentionally described as one row short, exercising the validator's row-count check without requiring a binary fixture in the repo.
