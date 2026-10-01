# Mixed-entity GDSC query with no-match handling

## User Persona
An intermediate developer writing a Python script that drives the GDSC query
API programmatically. They know `query_gdsc` exists and that GDSC stores drug
lists, gene targets, pathways, and cell-line identifiers, but want the exact
mixed-entity call and the empty-match contract before writing code.

## Scenario Coverage
- Skill area: `gdsc` (sub-skill of `drug-molecular-property`)
- Capability: multi-entity `query_gdsc` with per-source match counts + no-match empty list
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/gdsc/SKILL.md` (Multiple entities call,
  return format, empty-list rule)
- Trigger expectation: Naming GDSC entity types (drug, gene target, cell line)
  and a batch query is squarely the `gdsc` sub-skill territory.

## Expected Successful Behavior
- Produces the documented multi-entity call
  `results = mod.query_gdsc(["Nutlin", "A549", "EGFR"])` from SKILL.md.
- Explains each entity is matched per source file (screened compounds, GDSC1/GDSC2
  dose response, Cell Model Passports), returning a list where each element is a
  `{source, match_count, matches}` object.
- States that `query_gdsc` returns an empty list when no matches are found, and
  that it returns `{"error": "..."}` when the data directory is missing/empty.
- Uses `SourceFileLoader` to load `60_GDSC_GDSC2.py` as the script.

## Failure Signals
- Substitutes a wrong API name or a made-up `target`/`pathway`.
- Claims an unmatched entity raises an exception instead of returning an empty list.
- Ignores the `{"error": "..."}` contract for missing data.
- Points to the original DrugClaw checkout rather than the generated skill.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
