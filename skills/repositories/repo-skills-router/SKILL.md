---
name: "repo-skills-router"
description: "Routes substantive ML, AI, data, scientific-computing, and software-engineering requests to the smallest useful set of managed repository skills. Invoke proactively when a request names or implies a package, framework, model family, dataset, modality, workflow, backend, deployment target, evaluation method, or implementation approach that may benefit from repository guidance, even if no repository is named. Narrow progressively from area to family to repository root: inspect only the one or two most likely area pages; compare candidates by capability, task surface, model/data format, training versus inference versus evaluation intent, runtime constraints, and root-skill description; then open only the selected root and relevant sub-skills, references, or scripts. Select multiple repositories only when each adds a distinct capability. Do not load the whole collection, treat dependencies or incidental integrations as capabilities, choose by name alone, or force a match when no exact taxonomy family applies."
metadata:
  disco-role: "operating"
---
# Repo Skills Router

Use this router for substantive requests where a managed repository skill may provide implementation guidance. It is a progressive-disclosure index, not a replacement for the selected repository skill.

## Routing procedure

1. Identify the user's dominant capability, workflow, data/model format, and runtime intent.
2. Read only the one or two most likely area pages below.
3. Compare the relevant family pages, especially when training, inference, evaluation, deployment, or similarly named repositories overlap.
4. Open the selected repository root at `../repo-skills/<skill-id>/SKILL.md`, then read only its relevant sub-skills, references, and scripts.
5. If no exact family fits, do not force a repository match; continue with the general task context or report that the managed collection has no exact route.

A repository may appear in several families. Choose the smallest set of repository roots that directly covers the request, and do not load every candidate listed on a family page.

## Area quick map

| Area | Populated families | Repository memberships | Area page |
| --- | ---: | ---: | --- |
| [Biomedical AI](references/areas/biomedical-ai.md) | 2 | 17 |
| [Scientific Computing](references/areas/scientific-computing.md) | 8 | 110 |

## Maintenance

The machine-readable files under `references/index/` are the generated routing source of truth. Do not hand-edit area or family pages. For import, refresh, extension, or taxonomy changes, read [references/maintenance.md](references/maintenance.md) and use the verified importer/updater transaction.
