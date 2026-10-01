# Python API training then CLI prediction (integration)

## User Persona
A maintainer/advanced user who wants to hand-write a Chemprop model in Python (custom architecture) and then reuse the saved artifact through the standard CLI. They need both the Python API wiring and the prediction handoff, so this case crosses two sub-skills.

## Scenario Coverage
- Skill area: integration (cross `python-api-modeling` → `prediction-fingerprints`)
- Capability: programmatic dataset/model construction, Lightning training, save_model with output columns, then `chemprop predict` on the saved artifact
- Difficulty: advanced
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/python-api-modeling/SKILL.md`, `references/api-reference.md`, `references/python-workflows.md`, `sub-skills/python-api-modeling/scripts/chemprop_api_smoke.py`, `sub-skills/prediction-fingerprints/SKILL.md`
- Trigger expectation: the prompt names `MoleculeDataset`, `BondMessagePassing`, `MeanAggregation`, `RegressionFFN`, `MPNN`, Lightning, save/load and `chemprop predict` — crosses both sub-skills, so the root skill should route across them.

## Expected Successful Behavior
- Shows `data.MoleculeDataset` built from `data.MoleculeDatapoint.from_smi(smi, y)` datapoints.
- Shows `nn.BondMessagePassing(d_h=..., depth=...)`, `nn.MeanAggregation()`, `nn.RegressionFFN(input_dim=..., hidden_dim=..., n_tasks=1)`, wrapped in `models.MPNN(..., metrics=[nn.RMSE(), nn.MAE()])`.
- Trains with `pl.Trainer(accelerator="cpu", devices=1, max_epochs=...)` and `trainer.fit(model, loader)`, using `build_dataloader(...)` and `shuffle=False` for prediction.
- Saves with `chemprop.models.save_model(model, ..., output_columns=...)`.
- Explains the prediction handoff to `chemprop predict --test-path ... --model-path <saved_file>` and that prediction artifacts can be reloaded via `chemprop.models.load_model` or `*.load_from_file`.
- Points to the bundled `chemprop_api_smoke.py` as a runnable CPU smoke.

## Failure Signals
- Uses a CLI-only answer despite the explicit request for Python API code.
- Sets predictor `input_dim` incorrectly (should equal the feature dimension the model produces).
- Uses `shuffle=True` for the prediction loader (ambiguous row order / Lightning warning).
- Fails to hand off to `chemprop predict` or to describe `save_model`/`load_output_columns`.
- Tells the user to copy from the original Chemprop checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
