# Router maintenance

This router is generated from the fixed area -> family taxonomy and the v2 `references/repo-routing-metadata.json` fragment attached to each repository skill. The compact fragment contains only identity, taxonomy hash, status, and exact assignments. Full classification evidence belongs in the external production routing decision artifact, not in the runtime skill graph.

## Import contract

1. Finish and independently verify the generated repository skill.
2. Classify it against the exact taxonomy using repository evidence plus the generated skill as navigation context.
3. Write the external routing decision with assignment-specific rationale, evidence, and assignment-level confidence (`high`, `medium`, or `low`).
4. Write the minimal v2 metadata fragment only after the decision is made; confidence remains in the central assignment index and is not copied into runtime metadata.
5. Run the verified importer/updater under the shared lock so the skill, metadata, indexes, and router are updated together.

## Current generated scope

- Areas in taxonomy: 2
- Routable repository skills: 109
- Taxonomy memberships: 127
