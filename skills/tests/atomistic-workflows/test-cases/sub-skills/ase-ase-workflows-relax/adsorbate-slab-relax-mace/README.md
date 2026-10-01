# Adsorbate/slab relaxation with the MACE backend

## User Persona
An intermediate computational-chemistry user who knows geometry optimization but wants the exact ASE relax script with a specific force threshold and optimizer, plus a recovery path. They name MACE explicitly, so the case must pull the MACE adapter config into the relax workflow.

## Scenario Coverage
- Skill area: sub-skill `ase-ase-workflows-relax`
- Capability: geometry-optimization ASE script, optimizer (BFGS/FIRE) + convergence policy (`fmax`, max steps), constraints, MACE backend adapter (checkpoint, device, precision)
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/ase-ase-workflows-relax/SKILL.md`, `sub-skills/ase-ase-calculators-mace/SKILL.md`, `sub-skills/ase-ase-workflows/references/commands-and-workflow.md`
- Trigger expectation: the prompt names ASE, relaxation, force threshold, optimizer, MACE — a direct relax-workflow trigger.

## Expected Successful Behavior
- Routes to `ase-ase-workflows-relax`.
- Produces an ASE relax script using a BFGS (or FIRE) optimizer with `fmax=0.02`.
- Configures the MACE calculator with the model checkpoint path and a device/precision policy (the MACE adapter sub-skill).
- Recommends fixed-atom/layer constraints if applicable and a max-steps/restart policy.
- Explains likely non-convergence causes and how to switch to FIRE / raise max steps.
- Returns optimizer/convergence summary plus assumptions and unresolved choices.

## Failure Signals
- Produces an MD trajectory instead of a relaxation.
- Omits the force threshold or the optimizer choice.
- Ignores the MACE checkpoint/device requirements.
- Does not offer a convergence/restart recovery path.
- Points the user into the original atomistic-workflows source checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
