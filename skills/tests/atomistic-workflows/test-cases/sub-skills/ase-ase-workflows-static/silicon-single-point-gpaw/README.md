# Silicon single-point energy with GPAW (static workflow)

## User Persona
A novice-to-intermediate user who knows what "single-point energy and forces" means but is new to the atomistic-workflows / ASE routing tree and wants a ready script. They name the GPAW backend explicitly, so the case must cross the workflow router into the static sub-skill and pull the GPAW adapter config.

## Scenario Coverage
- Skill area: sub-skill `ase-ase-workflows-static` (routed from `ase` → `ase-ase-workflows` → static)
- Capability: static single-point ASE workflow script, requested properties (energy/forces), backend adapter integration (GPAW mode/XC/k-points)
- Difficulty: basic
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/ase-ase-workflows-static/SKILL.md`, `sub-skills/ase-ase-calculators-gpaw/SKILL.md`, `sub-skills/ase-ase-calculators/references/commands-and-workflow.md`
- Trigger expectation: the prompt names ASE, GPAW, single-point energy/forces, a structure — a direct atomistic-workflows trigger.

## Expected Successful Behavior
- Routes: static workflow selected over relax/md/neb.
- Produces an ASE script that attaches a GPAW calculator (plane-wave `PW` mode, an XC functional, a k-point grid) and evaluates energy and forces (`atoms.get_potential_energy()`, `atoms.get_forces()`).
- Reports a requested-property checklist (energy, forces, and optionally stress) and states unresolved backend choices.
- If execution were requested, would note the `dpdisp-submit` handoff; here it stays as a reproducible script.
- Keeps workflow logic (static) separate from backend logic (GPAW adapter), per the routing policy.

## Failure Signals
- Answers about relaxation/MD instead of a single point.
- Selects a backend without any configuration (no mode/XC/k-points).
- Blends backend parameters into the workflow sub-skill or vice versa (violating the workflow/backend separation rule).
- Doesn't name the properties that will be returned.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
