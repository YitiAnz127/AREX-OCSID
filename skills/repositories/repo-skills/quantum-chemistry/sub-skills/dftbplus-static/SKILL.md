---
name: dftbplus-static
description: "Prepare DFTB+ single-point (static) task inputs from a user-provided structure and essential SCC/settings choices."
disable-model-invocation: true
metadata:
  disco-role: operating
---

# dftbplus-static — quantum-chemistry sub-skill


# DFTB+ Static (Subskill)

## Scope

This skill prepares static tasks only.

It should generate:

- geometry input
- `dftb_in.hsd` for static SCC/non-SCC run
- output/restart naming policy

It should not submit or execute jobs.

## Must provide

- structure input
- SK parameter set choice
- SCC policy (`SCC`/non-`SCC`) and convergence settings
- k-point policy for periodic systems

## Usually should be explicit

- charge/spin setup when relevant
- mixer/max-iteration/tolerance settings
- dispersion/third-order corrections when relevant

## Expected output

1. static-task input/script layout
1. settings summary and assumptions
1. unresolved choices for confirmation
1. handoff note to `dpdisp-submit` if execution is requested

