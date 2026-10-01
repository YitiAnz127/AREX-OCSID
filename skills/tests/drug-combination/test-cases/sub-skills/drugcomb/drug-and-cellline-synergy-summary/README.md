# DrugComb drug-name and cell-line synergy search

## User Persona
A drug-discovery researcher who knows the broad purpose (query drug-combination synergy) but is not familiar with the drugcomb query API. They have the DrugComb summary CSV loaded and want concrete search + summary behavior.

## Scenario Coverage
- Skill area: sub-skill `drugcomb`
- Capability: pattern-based entity search (drug name `5-FU`, cell line `MCF-7`), `search`, `summarize`, synergy columns (`synergy_zip`, `synergy_bliss`)
- Difficulty: basic
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/drugcomb/SKILL.md`
- Trigger expectation: the prompt names DrugComb, a drug name, a cell line and synergy scores — a direct `drugcomb` trigger.

## Expected Successful Behavior
- Routes to `drugcomb` (not `drugcombdb`).
- Uses `search(data, "5-FU")` (case-insensitive substring on `drug_row`/`drug_col`) and `search(data, "MCF-7")` (case-insensitive substring on `cell_line_name`).
- Summarizes hits with `summarize(hits, entity)` including `synergy_zip` and `synergy_bliss` columns.
- References the `drugcomb` SKILL.md API (`load_drugcomb`, `search`, `summarize`, `to_json`).

## Failure Signals
- Routes to `drugcombdb` (a different database with a different schema).
- Uses wrong column names (`Drug1`, `Drug2`, `Cell`, `Synergy`, `PMID` — those are DrugCombDB columns, not DrugComb's).
- Searches by an exact/non-substring rule when the SKILL mandates case-insensitive substring.
- Ignores the `summarize` compact output.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
