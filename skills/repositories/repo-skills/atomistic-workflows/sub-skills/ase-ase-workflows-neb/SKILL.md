---
name: ase-ase-workflows-neb
description: "Prepare ASE NEB workflow tasks with backend-agnostic controls."
disable-model-invocation: true
metadata:
  disco-role: operating
---

# ase-ase-workflows-neb — atomistic-workflows sub-skill


# ASE NEB Workflow (Subskill)

## Scope

This subskill prepares NEB workflow tasks only.

It should generate:

- NEB workflow script with image setup
- optimizer/spring/convergence settings
- output policy for path and barriers

## Must provide

- initial and final structures
- selected backend adapter
- number of images
- optimizer and convergence policy

## Usually should be explicit

- interpolation policy
- climbing-image setting
- spring-constant policy

## Expected output

1. NEB workflow script/layout
1. image/convergence summary
1. assumptions and unresolved choices
1. handoff note to `dpdisp-submit` if execution is requested

