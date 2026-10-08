---
name: ase-ase-workflows-static
description: "Prepare ASE static (single-point) workflow tasks with backend-agnostic workflow controls."
disable-model-invocation: true
metadata:
  ocsid-role: operating
---

# ase-ase-workflows-static — atomistic-workflows sub-skill


# ASE Static Workflow (Subskill)

## Scope

This subskill prepares static workflow tasks only.

It should generate:

- workflow script/layout for single-point evaluation
- standardized output policy (energy/forces/stress)
- backend adapter integration points

## Must provide

- structure input
- selected backend adapter
- requested properties (energy/force/stress)

## Expected output

1. static workflow script/layout
1. requested-property checklist
1. assumptions and unresolved choices
1. handoff note to `dpdisp-submit` if execution is requested

