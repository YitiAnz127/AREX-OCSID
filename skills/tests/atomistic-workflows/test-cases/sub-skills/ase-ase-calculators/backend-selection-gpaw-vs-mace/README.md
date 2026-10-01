# Backend selection: GPAW vs MACE

## User Persona
A user (possibly novice at the ASE ecosystem) who needs a calculator backend decision for a whole project and asks the agent to compare GPAW and MACE, including each adapter's configuration prerequisites. This tests the `ase-ase-calculators` router's selection/clarification behavior as a support workflow.

## Scenario Coverage
- Skill area: sub-skill `ase-ase-calculators` (backend adapters router; routes to `gpaw` or `mace`)
- Capability: backend selection/configuration comparison, adapter prerequisites (GPAW mode/XC/k-points vs MACE checkpoint/device/precision)
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/ase-ase-calculators/SKILL.md`, `sub-skills/ase-ase-calculators-gpaw/SKILL.md`, `sub-skills/ase-ase-calculators-mace/SKILL.md`, `sub-skills/ase-ase-calculators/references/commands-and-workflow.md`
- Trigger expectation: the prompt asks to compare/select the calculator backend — a direct `ase-ase-calculators` trigger (backend-adapter-level intent, per the `ase` top-level router routing rules).

## Expected Successful Behavior
- Routes to `ase-ase-calculators` (backend intent, not a workflow).
- Compares GPAW (needs `PW`/`LCAO`/`FD` mode, XC, k-point policy) vs MACE (needs model checkpoint/path, `cpu`/`cuda` device, precision).
- Recommends a backend given the workstation constraint and states the prerequisites the user must supply.
- If genuinely ambiguous, proposes options and asks one focused question (per the calculators router policy).
- Returns a calculator configuration summary plus unresolved backend prerequisites.

## Failure Signals
- Writes workflow-level logic (relax/md controls) instead of sticking to backend selection.
- Recommends a backend without stating its prerequisites (mode/XC/k-points or checkpoint/device/precision).
- Ignores the workstation/GPU constraint.
- Invents a third backend not present in the skill tree.
- Points the user into the original atomistic-workflows source checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
