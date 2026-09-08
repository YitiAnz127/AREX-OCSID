---
name: dft-vasp-static
description: "Prepare VASP static SCF input tasks from a user-provided structure and essential DFT settings."
disable-model-invocation: true
metadata:
  disco-role: operating
---

# dft-vasp-static — quantum-chemistry sub-skill


# VASP Static SCF (Subskill)

## Scope

This skill prepares static SCF tasks only.

It should generate:

- `POSCAR`
- `INCAR`
- optional `KPOINTS` (manual mesh only when requested)
- POTCAR mapping/assembly instructions

It should not submit or execute jobs.

## Must provide

- structure input
- `ENCUT`
- k-point policy (`KSPACING` default or explicit mesh)
- `ISMEAR` / `SIGMA`
- POTCAR mapping for each element

## Usually should be explicit

- `EDIFF`
- `NELM`
- `PREC`
- `LREAL`
- `ISPIN` / `MAGMOM` when relevant
- `IVDW` when relevant

## K-point policy

- default: `KSPACING` in `INCAR`
- generate `KPOINTS` only when user asks for explicit mesh

## Expected output

1. task directory with generated input files
1. settings summary and assumptions
1. unresolved choices for user confirmation
1. handoff note to `dpdisp-submit` if execution is requested

