# Train a multiclass binary toxicity classifier from a CSV

## User Persona
An intermediate cheminformatics user who understands molecular property prediction concepts (endpoints, classification, metrics) and has Chemprop installed, but is NOT familiar with the Chemprop 2.2 CLI flags. They rely on the agent to assemble a correct, runnable command.

## Scenario Coverage
- Skill area: sub-skill `training-cli` (routed from the chemprop root skill)
- Capability: `chemprop train` command construction for multi-endpoint binary classification (task type, metrics, tracking metric, class balance, split, output layout)
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/training-cli/SKILL.md`, `sub-skills/training-cli/references/cli-reference.md`, `sub-skills/training-cli/references/training-workflows.md`, `sub-skills/training-cli/scripts/chemprop_train_command_builder.py`
- Trigger expectation: the prompt names `chemprop`, toxicity endpoints, binary classification, metrics and a training goal — a direct trigger for the chemprop root skill and its `training-cli` route.

## Expected Successful Behavior
- Routes to `training-cli`.
- Produces a `chemprop train` command with `--task-type classification`, `--smiles-columns smiles`, `--target-columns tox_a tox_b tox_c`, `--metrics roc prc accuracy f1`, `--tracking-metric prc`, `--class-balance`, an explicit `--output-dir`, and CPU-safe `--accelerator cpu --epochs 3 --num-workers 0`.
- Explains that `--class-balance` is only valid for `--task-type classification` and that `--tracking-metric` must be among `--metrics`.
- Explains the default random/scaffold split and that the checkpoint lands at `<output-dir>/model_0/best.pt` plus a `config.toml`.
- May suggest the bundled `chemprop_train_command_builder.py` to plan the command.

## Failure Signals
- Tells the user to open files from the original Chemprop checkout.
- Uses a generic example without matching `tox_a tox_b tox_c` targets or the `classification` task type.
- Uses `--num-folds`/`-k`, which was removed in Chemprop 2.2 (should be `--num-replicates`).
- Puts `--tracking-metric` to a metric not in `--metrics`.
- Omits `--class-balance` or claims it works for regression.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
