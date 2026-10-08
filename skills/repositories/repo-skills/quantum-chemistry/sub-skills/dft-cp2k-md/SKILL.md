---
name: dft-cp2k-md
description: "Prepare CP2K molecular-dynamics task inputs from a user-provided structure and MD controls."
disable-model-invocation: true
metadata:
  ocsid-role: operating
---

# dft-cp2k-md — quantum-chemistry sub-skill


# CP2K MD (Subskill)

## Scope

This skill prepares MD tasks only.

It should generate:

- MD-capable CP2K input
- ensemble/integrator/thermostat controls
- trajectory/output policy

It should not submit or execute jobs.

## Must provide

- structure input
- basis/potential set choice
- timestep and number of steps
- ensemble intent (`NVE`/`NVT`/`NPT`)
- temperature/pressure control policy

## Usually should be explicit

- initial velocity policy
- output stride for energies/trajectory
- charge/spin and SCF policy

## Expected output

1. MD-task input layout
1. MD control summary and assumptions
1. unresolved choices for confirmation
1. handoff note to `dpdisp-submit` if execution is requested

