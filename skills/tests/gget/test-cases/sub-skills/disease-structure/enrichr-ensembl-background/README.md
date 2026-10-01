# Enrichr with versioned Ensembl IDs and an explicit background

## User Persona
An advanced bioinformatics analyst who knows gget exists but not the Enrichr
details. They need correct namespace handling (versioned Ensembl IDs), a KEGG
pathway library, an explicit experimental background, and a reproducible top-N
selection.

## Scenario Coverage
- Skill area: `disease-structure` (sub-skill of `gget`)
- Capability: `gget.enrichr` Ensembl conversion + ensembl background + reproducible top-N
- Difficulty: advanced
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/disease-structure/SKILL.md`,
  `sub-skills/disease-structure/references/enrichr.md`
- Trigger expectation: The prompt is gene-set enrichment on human genes — a
  documented `disease-structure` capability. It intentionally exercises the
  versioned-Ensembl edge case flagged as a "difficult case" in the SKILL.md.

## Expected Successful Behavior
- Routes to `disease-structure` for enrichment.
- Uses `gget.enrichr([...versioned IDs...], database="KEGG_2021_Human", ensembl=True,
  background_list=[...IDs...], ensembl_bkg=True)` per enrichr.md.
- Explains gget strips the version at the first dot, runs an Ensembl `info`
  lookup, and uses the first returned `ensembl_gene_name`; unknown IDs are
  warned and skipped, and if none remain it returns `None`.
- States the resulting DataFrame columns in order: rank, path_name, p_val,
  z_score, combined_score, overlapping_genes, adj_p_val, database.
- Selects top-N locally (there is no limit parameter), e.g. `[0:N]` or `head(N)`,
  and records library/species/conversion for reproducibility.
- Notes `pykegg` is only needed for `kegg_out` pathway rendering.

## Failure Signals
- Passing Ensembl IDs as if they were symbols (missing `ensembl=True`).
- Claiming conversion preserves versions or that `limit` exists on Enrichr.
- Inventing column names not in enrichr.md (e.g. wrong order or a made-up column).
- Opening the original gget source checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
