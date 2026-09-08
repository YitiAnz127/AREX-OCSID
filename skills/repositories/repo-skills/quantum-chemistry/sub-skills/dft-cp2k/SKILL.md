---
name: dft-cp2k
description: "Route CP2K requests to task-specific subskills based on user intent."
disable-model-invocation: true
metadata:
  disco-role: operating
---

# dft-cp2k — quantum-chemistry sub-skill


# CP2K Task Router

Use this skill as the **top-level CP2K orchestration layer**.

## Purpose

This skill routes requests to one task-specific CP2K subskill path:

- `dft-cp2k/static`
- `dft-cp2k/relax`
- `dft-cp2k/md`
- `dft-cp2k/electronic`

## Scope

This router skill should:

- require user-provided structure or prerequisite context
- classify request intent into one CP2K task type
- collect minimal shared context before dispatch
- delegate detailed parameter handling to selected subskill
- enforce consistent output/handoff policy across subskills

This router skill should **not**:

- own detailed templates for all CP2K tasks
- execute or submit calculations
- bypass subskill-specific guardrails

## Hard requirement

The user must provide enough starting context:

- structure input for `static` / `relax` / `md`
- prerequisite converged context for `electronic`

If prerequisites are missing, stop and ask for them.

## Routing rules

1. If user requests single-point SCF/energy: route to `dft-cp2k/static`.
1. If user requests geometry optimization: route to `dft-cp2k/relax`.
1. If user requests molecular dynamics: route to `dft-cp2k/md`.
1. If user requests electronic analysis workflow: route to `dft-cp2k/electronic`.
1. If intent is ambiguous, ask one focused clarification question before routing.

## Shared policy for all subskills

- do not invent missing basis/potential files
- expose assumptions and unresolved scientific choices explicitly
- return handoff-ready task layout
- if execution is requested, hand off to `dpdisp-submit`

## Output from router

Provide:

1. selected subskill path
1. why it was selected
1. minimal missing inputs (if any)
1. explicit next step (invoke selected subskill)

