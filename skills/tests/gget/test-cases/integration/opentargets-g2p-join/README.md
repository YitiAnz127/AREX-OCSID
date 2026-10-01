# Open Targets diseases -> G2P residue features join

## User Persona
An advanced analyst/maintainer who knows gget's `disease-structure` surface but
wants a cross-resource handoff: Open Targets disease associations feeding an
Ensembl gene key, then G2P residue-level features for the same gene. They demand
honest statement of the public G2P boundary (no portal-only variant overlays).

## Scenario Coverage
- Skill area: integration — crosses two `disease-structure` capabilities
  (`opentargets` and `g2p`) plus their identifier-resolution and boundary rules
- Capability: Open Targets disease associations chained to G2P residue features with explicit UniProt resolution
- Difficulty: advanced
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/disease-structure/SKILL.md`,
  `sub-skills/disease-structure/references/opentargets.md`,
  `sub-skills/disease-structure/references/g2p.md`
- Trigger expectation: The prompt combines disease-target associations with
  residue-level annotations — squarely `disease-structure`; the case is placed in
  `integration/` because the correct answer merges two capability contracts and
  a portal-only boundary rather than a single module call. It is synthesized from
  the documented synthetic case in opentargets.md and g2p.md (no repo-native
  tests/examples tree is captured for gget).

## Expected Successful Behavior
- Routes to `disease-structure` for both calls.
- Gives `gget.opentargets("ENSG...", resource="diseases", limit=N)` and
  `gget.g2p("BRCA1", uniprot_id="P38398", resource="features", residues=[...])`
  (or a generic gene/UniProt pair), per opentargets.md and g2p.md.
- Explains Open Targets disease rows are EFO-mapped associations (may be MONDO,
  HP, Orphanet, or EFO/measurement), not a UniProt accession, so the gene→UniProt
  join for G2P is a separate labeled step.
- States clearly that public G2P rows do NOT include the portal web UI's gnomAD,
  ClinVar, or HGMD overlays, and that those would require the G2P portal.
- Keeps the two result tables as separate artifacts (do not imply a disease row
  is a residue-level causal annotation).
- Uses `residues` as a client-side filter with stable columns like `residueId`/`AA`.

## Failure Signals
- Implies Open Targets disease rows provide a UniProt/residue-level annotation.
- Fabricates gnomAD/ClinVar/HGMD columns from the public G2P feature table.
- Runs `gget.pdb`/AlphaFold to answer a G2P annotation question (misdirecting to
  sequence-tools).
- Merges disease and G2P rows as one table without labeling the separate join.
- Points at the original gget source repository checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
