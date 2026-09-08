---
name: ase-ase-calculators-gpaw
description: "Configure ASE GPAW calculator adapter settings for ASE workflows."
disable-model-invocation: true
metadata:
  disco-role: operating
---

# ase-ase-calculators-gpaw — atomistic-workflows sub-skill


# ASE GPAW Adapter (Subskill)

## Scope

This adapter configures GPAW backend parameters for ASE workflows.

It should return calculator configuration, not workflow logic.

## Must provide

- GPAW mode (`PW` / `LCAO` / `FD`)
- XC choice
- k-point policy
- convergence controls

## Usually should be explicit

- occupation/smearing policy
- spin setup
- restart/checkpoint policy

## Expected output

1. calculator configuration payload
1. backend assumptions and prerequisites
1. unresolved backend choices

