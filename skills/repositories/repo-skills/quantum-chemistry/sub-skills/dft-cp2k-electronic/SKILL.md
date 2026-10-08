---
name: dft-cp2k-electronic
description: "Prepare CP2K electronic-analysis task inputs from prior converged context."
disable-model-invocation: true
metadata:
  ocsid-role: operating
---

# dft-cp2k-electronic — quantum-chemistry sub-skill


# CP2K Electronic Analysis (Subskill)

## Scope

This skill prepares post-ground-state electronic-analysis tasks.

It should:

- verify prerequisite converged context
- prepare analysis-specific input controls
- report assumptions and unresolved choices

It should not submit or execute jobs.

## Prerequisites

Require explicit prior converged context compatible with requested analysis.

If prerequisites are missing, stop and ask for them.

## Must provide

- source context path
- analysis intent (for example DOS/PDOS/band-like workflow)
- mesh/path/resolution policy as applicable

## Usually should be explicit

- projection settings
- broadening/plotting policy
- export format expectations

## Expected output

1. analysis-stage input updates
1. prerequisite check summary
1. settings summary and assumptions
1. handoff note to `dpdisp-submit` if execution is requested

