# Canonical DrugCombDB drug-pair synergy query

## User Persona
A researcher who wants to reproduce a published drug-combination record from the canonical DrugCombDB dataset. They are not familiar with the drugcombdb query API but know the data has synergy values and PMIDs.

## Scenario Coverage
- Skill area: sub-skill `drugcombdb`
- Capability: canonical DrugCombDB CSV query by drug pair and/or cell line, returning synergy/synergy-type/PMID with an optional result limit
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/drugcombdb/SKILL.md`
- Trigger expectation: the prompt names DrugCombDB, a drug pair, synergy type and PMID — a direct `drugcombdb` trigger.

## Expected Successful Behavior
- Routes to `drugcombdb` (not `drugcomb`).
- Uses the drugcombdb API (`search_drug_pair(drug1, drug2, limit)` and/or `search_cell_line(cell, limit)`, `search(entity, limit)`, `summarize(results, entity)`).
- Reports the canonical columns `Drug1`, `Drug2`, `Cell`, `Synergy`, `SynergyType`, `PMID`.
- Applies a result limit to return a compact list.

## Failure Signals
- Uses the DrugComb schema (`synergy_zip`, `synergy_bliss`, `drug_row`, `drug_col`) instead of the DrugCombDB columns.
- Ignores the `limit` parameter or the `SynergyType`/`PMID` columns.
- Routes to the wrong sub-skill.
- Points the user into the original drug_combination source checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
