# ARCHS4 correlation and tissue atlas

## User Persona
A novice-to-intermediate biologist who knows they want bulk expression patterns
for a gene but not gget's ARCHS4 API. They need both the correlation workflow and
the tissue-atlas workflow, plus the failure contract for invalid arguments.

## Scenario Coverage
- Skill area: `expression-omics` (sub-skill of `gget`)
- Capability: `gget.archs4` correlation + tissue atlas, invalid-argument contract
- Difficulty: basic
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/expression-omics/SKILL.md`,
  `sub-skills/expression-omics/references/workflows.md`,
  `sub-skills/expression-omics/references/api-signatures.md`
- Trigger expectation: The prompt asks about expression/correlation/tissue — a
  documented `expression-omics` (ARCHS4) capability.

## Expected Successful Behavior
- Routes to `expression-omics`, not disease-structure or gene-annotation.
- Gives `gget.archs4("STAT4", which="correlation", gene_count=25)` and
  `gget.archs4("STAT4", which="tissue", species="mouse")`.
- Explains correlation returns Pearson co-expression columns including
  `gene_symbol` and `pearson_correlation` and drops the queried gene; tissue mode
  returns tissue summary stats sorted by decreasing `median` with `id`/`median`
  columns (species must be human or mouse).
- States an invalid `which` or `species` fails before the request, and a missing
  gene returns `None` after an error log.

## Failure Signals
- Passes an invalid `which`/`species` and pretends it succeeds.
- Uses `which="tissue"` without a species, or species outside human/mouse.
- Claims the correlation table keeps the queried gene or that a missing gene
  returns an empty DataFrame instead of `None`.
- Points at the original gget source checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
