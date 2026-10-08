---
name: ase-ase-workflows-relax
description: "Prepare ASE geometry-optimization workflow tasks with backend-agnostic controls."
disable-model-invocation: true
metadata:
  ocsid-role: operating
---

# ase-ase-workflows-relax — atomistic-workflows sub-skill


# ASE Relax Workflow (Subskill)

## Scope

This subskill prepares relaxation workflow tasks only.

It should generate:

- optimizer workflow script (`BFGS`/`FIRE` etc.)
- convergence policy (`fmax`, max steps)
- constraints and trajectory/log policy

## Must provide

- structure input
- selected backend adapter
- optimizer choice
- force threshold and step limits

## Usually should be explicit

- fixed-atom/layer constraints
- stress-aware relaxation policy
- restart behavior

## Expected output

1. relax workflow script/layout
1. optimizer/convergence summary
1. assumptions and unresolved choices
1. handoff note to `dpdisp-submit` if execution is requested

