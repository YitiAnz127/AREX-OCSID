---
name: ase-ase-calculators-mace
description: "Configure ASE MACE calculator adapter settings for ASE workflows."
disable-model-invocation: true
metadata:
  ocsid-role: operating
---

# ase-ase-calculators-mace — atomistic-workflows sub-skill


# ASE MACE Adapter (Subskill)

## Scope

This adapter configures MACE backend parameters for ASE workflows.

It should return calculator configuration, not workflow logic.

## Must provide

- model checkpoint/path
- device policy (`cpu`/`cuda`)
- precision policy
- stress/force capability requirements

## Usually should be explicit

- batch/inference tuning
- model domain applicability note
- restart/checkpoint policy

## Expected output

1. calculator configuration payload
1. backend assumptions and prerequisites
1. unresolved backend choices

