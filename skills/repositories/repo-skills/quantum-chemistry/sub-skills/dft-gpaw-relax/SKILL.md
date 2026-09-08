---
name: dft-gpaw-relax
description: "Prepare GPAW geometry-relaxation task inputs/scripts from a user-provided structure and essential optimization settings."
disable-model-invocation: true
metadata:
  disco-role: operating
---

# dft-gpaw-relax — quantum-chemistry sub-skill


# GPAW Relaxation (Subskill)

## Scope

This skill prepares relaxation tasks only.

It should generate:

- structure input
- GPAW+ASE optimization script
- explicit force/step convergence controls

It should not submit or execute jobs.

## Relax intent is mandatory

Before producing the script, classify intent:

- ion-only relaxation
- cell+ion relaxation (with chosen ASE filter/policy)
- low-dimensional/slab-oriented constraints

If intent is ambiguous, ask for clarification.

## Must provide

- structure input
- XC and calculator mode settings
- optimizer choice (for example BFGS/FIRE)
- force threshold (`fmax`)
- step/trajectory/log policy

## Usually should be explicit

- stress/cell relaxation policy
- constraints for fixed atoms/layers
- k-point and smearing settings

## Expected output

1. relaxation-task script/input layout
1. explicit relaxation-policy rationale
1. settings summary and assumptions
1. unresolved choices for user confirmation
1. handoff note to `dpdisp-submit` if execution is requested

