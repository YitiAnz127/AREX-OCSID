# Ensemble prediction and fingerprint extraction

## User Persona
An intermediate-to-advanced user (possibly the same person who trained the ensemble) who knows Chemprop's model artifacts but wants the precise CLI flags and the filename rules for multi-model predict and fingerprint export. They want runnable commands, not generic advice.

## Scenario Coverage
- Skill area: sub-skill `prediction-fingerprints`
- Capability: ensemble predict (directory/`.` model paths, averaged + per-model outputs), fingerprint layer selection (`--ffn-block-index`), output naming
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/prediction-fingerprints/SKILL.md`, `references/model-artifacts.md`, `references/fingerprint-workflows.md`, `references/prediction-workflows.md`, `sub-skills/prediction-fingerprints/scripts/chemprop_predict_command_builder.py`
- Trigger expectation: prompt asks for `chemprop predict` and `chemprop fingerprint` on trained model artifacts — a direct `prediction-fingerprints` trigger.

## Expected Successful Behavior
- Emits `chemprop predict --test-path new_inputs.csv --model-paths runs/ensemble/model_0/best.pt runs/ensemble/model_1/best.pt --output predictions.csv --smiles-columns smiles` (or a directory path).
- Notes that directory paths are searched recursively for `.pt` only and that `.ckpt` must be passed explicitly.
- Explains that with multiple models Chemprop writes averaged predictions plus a `<output_stem>_individual<suffix>` file with per-model columns.
- Emits `chemprop fingerprint --test-path new_inputs.csv --model-path <model> --ffn-block-index 0 --output fingerprints.npz` and explains `--ffn-block-index 0` returns the post-aggregation representation before FFN layers.
- Explains that fingerprint outputs append a model index (e.g. `fingerprints_0.npz`, `fingerprints_1.npz`).
- Recommends the bundled `chemprop_predict_command_builder.py` to plan the commands.

## Failure Signals
- Claims directories are searched for `.ckpt` files too (they are not).
- Recommends an invalid output suffix (e.g. `.txt`) for predict or fingerprint.
- Omits required `--ffn-block-index` for fingerprint.
- Ignores `--smiles-columns` and silently relies on default first-column parsing despite the explicit `smiles` column.
- Tells the user to open model files or source from the original checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
