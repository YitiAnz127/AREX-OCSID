---
name: repo-skills-router
description: "Routes chemistry, biochemistry, molecular-science, pharmaceutical, and adjacent biomedical requests to the smallest useful set of managed repository skills. Narrow progressively from area to family to repository root, and load only the selected skill branch."
metadata:
  ocsid-role: operating
---

# Repo Skills Router

This bundled skill is the empty router template used by OCSID's repository
skill importer. It contains the chemistry and biomedical taxonomy but no
repository assignments. A generated live router adds area, family, and
repository membership pages from validated collection metadata.

Use progressive disclosure: OCSID Researcher first reads the generated area pages,
then one family page, and finally the smallest useful repository-skill
branch. The managed collection is available to OCSID Researcher at runtime, so
cross-agent export is not required for OCSID.

## Routing procedure

1. Identify the requested capability, workflow, data format, and runtime intent.
2. Read only the most likely area and family pages in the generated live router.
3. Open the selected repository root at `../repo-skills/<skill-id>/SKILL.md`.
4. Load only the relevant sub-skills, references, and scripts.
5. If no exact family fits, do not force a match.

## Empty template state

`references/index/taxonomy.json` is populated. The repository and assignment
indexes are empty until a collection build or import transaction creates the
live router.

## Maintenance

Read [references/maintenance.md](references/maintenance.md) before changing
the taxonomy or import/update workflow.
