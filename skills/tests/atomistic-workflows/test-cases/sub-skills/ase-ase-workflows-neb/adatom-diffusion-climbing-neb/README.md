# Adatom diffusion climbing-image NEB with MACE

## User Persona
An advanced user who wants a transition-state pathway with specific NEB parameters: image count, climbing-image, spring constant, and the MACE backend. This exercises the deepest workflow leaf and the barrier-output contract.

## Scenario Coverage
- Skill area: sub-skill `ase-ase-workflows-neb`
- Capability: NEB workflow script (image setup, optimizer/spring/convergence), climbing-image, barrier/path output policy, MACE adapter
- Difficulty: advanced
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/ase-ase-workflows-neb/SKILL.md`, `sub-skills/ase-ase-calculators-mace/SKILL.md`, `sub-skills/ase-ase-workflows/references/commands-and-workflow.md`
- Trigger expectation: the prompt names NEB, reaction path / transition state, images, climbing image, barrier, MACE — a direct NEB trigger.

## Expected Successful Behavior
- Routes to `ase-ase-workflows-neb`.
- Produces a NEB script from initial/final structures with `n 7` (or climber) images via an interpolation/nudged setup, a climbing-image flag, and an optimizer + spring-constant policy.
- Configures the MACE calculator on the images.
- Extracts and reports the barrier and path energies from the optimized band.
- Returns an image/convergence summary and states assumptions (interpolation policy, spring constant).

## Failure Signals
- Conflates NEB with an ordinary optimization or a single geometry relax.
- Omits the number of images or the climbing-image setting.
- Ignores the initial/final endpoint requirement.
- Does not produce a barrier/path-output plan.
- Points the user into the original atomistic-workflows source checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
