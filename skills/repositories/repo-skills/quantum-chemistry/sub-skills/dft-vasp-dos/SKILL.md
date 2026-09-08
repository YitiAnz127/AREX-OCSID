---
name: dft-vasp-dos
description: "Prepare VASP DOS workflow inputs from existing SCF artifacts and user-specified DOS settings."
disable-model-invocation: true
metadata:
  disco-role: operating
---

# dft-vasp-dos — quantum-chemistry sub-skill


# VASP DOS Preparation (Subskill)

## Scope

This skill prepares DOS-stage input tasks only.

It should:

- verify prerequisite SCF context is available
- prepare DOS-specific INCAR/KPOINTS settings
- report assumptions and unresolved choices

It should not submit or execute jobs.

## Prerequisites

Require explicit availability of prior SCF outputs as needed by the target workflow (for example charge density / wavefunction continuity expectations).

If prerequisites are missing, stop and ask for them.

## Must provide

- source SCF context path
- DOS intent (`total DOS` or `projected DOS`)
- energy-window / resolution expectations
- smearing policy and key electronic settings

## Usually should be explicit

- `NEDOS`
- `LORBIT`
- `ISMEAR` / `SIGMA`
- k-point policy

## Expected output

1. DOS-stage task directory/input updates
1. prerequisite check summary
1. settings summary and assumptions
1. handoff note to `dpdisp-submit` if execution is requested

