# Cross-database synergy comparison (DrugComb vs DrugCombDB)

## User Persona
An advanced researcher who wants to reconcile the two bundled drug-combination data sources for the same combination. This forces the agent to route to both `drugcomb` and `drugcombdb`, use the correct per-source API and schema, and not silently merge the two distinct formats.

## Scenario Coverage
- Skill area: integration (cross `drugcomb` and `drugcombdb`)
- Capability: cross-database synergy comparison, schema differentiation (`synergy_zip`/`synergy_bliss` vs `Synergy`/`SynergyType`/`PMID`), per-source API selection
- Difficulty: advanced
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/drugcomb/SKILL.md`, `sub-skills/drugcombdb/SKILL.md`
- Trigger expectation: the prompt names both DrugComb and DrugCombDB, their distinct schema columns and synergy fields — a cross-sub-skill trigger.

## Expected Successful Behavior
- Routes to both `drugcomb` (zip/bliss on `drug_row`/`drug_col`, `cell_line_name`) and `drugcombdb` (`Synergy`, `SynergyType`, `PMID` on `Drug1`/`Drug2`/`Cell`).
- Names the correct function per source (`search`/`summarize` for drugcomb; `search_drug_pair`/`search` for drugcombdb).
- Explicitly contrasts the two schemas and does not conflate them.
- Compares consistency of the combination + cell line across the two sources.

## Failure Signals
- Merges the two schemas into one column set.
- Uses drugcombdb columns on the drugcomb data or vice versa.
- Routes to only one sub-skill.
- Points the user into the original drug_combination source checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
