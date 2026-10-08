---
name: dft-vasp-band
description: "Prepare VASP band-structure workflow inputs from existing SCF context and user-specified band-path settings."
disable-model-invocation: true
metadata:
  ocsid-role: operating
---

# dft-vasp-band — quantum-chemistry sub-skill


# VASP Band Preparation (Subskill)

## Scope

This skill prepares band-structure-stage input tasks only.

It should:

- verify prerequisite SCF context is available
- generate line-mode/high-symmetry-path `KPOINTS`
- prepare stage-appropriate INCAR settings
- report assumptions and unresolved choices

It should not submit or execute jobs.

## Prerequisites

Require explicit prior SCF context and a clear crystal/path convention for band calculation.

If prerequisites are missing, stop and ask for them.

## Must provide

- source SCF context path
- crystal/path convention (or explicit k-path)
- band intent and output expectations
- key electronic/smearing policy for the band stage

## Usually should be explicit

- line-mode path source and tolerance
- `ISMEAR` policy for band stage
- `LORBIT` and projection-related options when requested

## Expected output

1. band-stage task directory/input updates
1. generated line-mode `KPOINTS` summary
1. prerequisite check summary
1. settings summary and assumptions
1. handoff note to `dpdisp-submit` if execution is requested

