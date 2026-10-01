# Diagnose the two-CSV trainval/test split error

## User Persona
A user who knows Chemprop's broad purpose and how to construct simple commands, but hit a concrete split error and wants an exact reproducible fix plus the underlying rule. They are debugging, not setting up a big experiment.

## Scenario Coverage
- Skill area: sub-skill `training-cli`
- Capability: two/three separate CSV path semantics, `--split-sizes` fix, test-split-fraction rule
- Difficulty: troubleshooting
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/training-cli/SKILL.md`, `sub-skills/training-cli/references/data-formats.md`, `sub-skills/training-cli/references/troubleshooting.md`, `sub-skills/training-cli/scripts/chemprop_train_command_builder.py`
- Trigger expectation: a failing `chemprop train` command with two `--data-path` files — a direct `training-cli` troubleshooting trigger.

## Expected Successful Behavior
- Explains that with two `--data-path` CSVs the second file is the test set and the test split fraction must be `0.0` (unless a split column/file overrides it).
- Recommends `--split-sizes 0.9 0.1 0.0` so 90% of trainval becomes training, 10% validation, and 0% is carved from the test file.
- Notes the default split fractions cause Chemprop to expect a nonzero test fraction and that `chemprop_train_command_builder.py` enforces the `0.0` test rule for two-file inputs.
- May note that three separate CSVs map directly to train/val/test without splits.

## Failure Signals
- Gives generic advice without naming `--split-sizes 0.9 0.1 0.0` or the `0.0` test rule.
- Suggests `-k`/`--num-folds` (removed).
- Tells the user to inspect the original repo source instead of using bundled references.
- Misstates the mapping (e.g. claims the second file becomes validation).

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
