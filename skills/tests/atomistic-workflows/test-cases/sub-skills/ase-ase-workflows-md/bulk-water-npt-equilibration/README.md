# Bulk water NPT equilibration MD with MACE

## User Persona
An intermediate user who wants a finite-temperature NPT equilibration trajectory and needs the ASE MD workflow script plus ensemble/integrator/barostat/output policy. They name MACE and the NPT ensemble, so the case must pull the MACE adapter config into the MD workflow.

## Scenario Coverage
- Skill area: sub-skill `ase-ase-workflows-md`
- Capability: MD workflow script, timestep/steps, ensemble/integrator/thermostat (NPT at 300 K / 1 atm), barostat, trajectory/output policy, checkpoint/restart, MACE adapter
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/ase-ase-workflows-md/SKILL.md`, `sub-skills/ase-ase-calculators-mace/SKILL.md`, `sub-skills/ase-ase-workflows/references/commands-and-workflow.md`
- Trigger expectation: the prompt names molecular dynamics, NPT, 300 K, thermostat/barostat, trajectory — a direct `md` workflow trigger.

## Expected Successful Behavior
- Routes to `ase-ase-workflows-md`.
- Produces an ASE MD script with a chosen timestep and step count for equilibration, an NPT thermostat/barostat at 300 K / 1 atm, and a trajectory/output policy.
- Configures the MACE calculator on the water box.
- States an explicit initial-velocity policy (e.g. Maxwell-Boltzmann at 300 K) and a checkpoint/restart policy.
- Returns an MD control summary (ensemble/temperature) and lists assumptions/unresolved choices.

## Failure Signals
- Produces a relax/static script instead of a dynamics trajectory.
- Omits timestep/steps or the ensemble/temperature policy.
- Ignores the pressure/barostat policy or the MACE device/checkpoint requirement.
- Doesn't specify the initial-velocity or restart policy.
- Points the user into the original atomistic-workflows source checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
