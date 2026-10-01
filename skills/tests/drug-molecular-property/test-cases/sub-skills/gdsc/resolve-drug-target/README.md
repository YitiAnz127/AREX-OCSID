# Resolve a GDSC drug molecular target

## User Persona
An oncology drug-discovery scientist who knows the GDSC dataset (Genomics of Drug
Sensitivity in Cancer) and its purpose, but is not familiar with the exact query
API of this repo skill. They have a local copy of the GDSC data directory and
just want the molecular target of a known drug, plus confidence in how the
lookup works.

## Scenario Coverage
- Skill area: `gdsc` (sub-skill of `drug-molecular-property`)
- Capability: `query_gdsc` drug-target lookup from the screened compound drug list
- Difficulty: basic
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/gdsc/SKILL.md` (Python API, return
  format, LLM integration example)
- Trigger expectation: The request names GDSC, a drug molecular property, and
  the target of Erlotinib — a direct trigger documented in the root
  `drug-molecular-property` skill and the `gdsc` sub-skill LLM example.

## Expected Successful Behavior
- Routes to the `gdsc` sub-skill of `drug-molecular-property`, not elsewhere.
- Produces a `query_gdsc("Erlotinib")` call and reports the match from the
  `screened_compounds_rel_8.4.csv` source, with `DRUG_NAME: Erlotinib`,
  `TARGET: EGFR`, and `TARGET_PATHWAY: EGFR signaling`.
- Explains that `query_gdsc` can be loaded via `SourceFileLoader`
  (`from importlib.machinery import SourceFileLoader`) as shown in SKILL.md.
- Describes the JSON return shape (`source`, `match_count`, `matches`).

## Failure Signals
- Tells the user to open the original `DrugClaw/drug_molecular_property`
  checkout files directly rather than using the skill's API.
- Invents a GDSC query function name or a target/pathway not present in the
  skill evidence (e.g. claiming a different gene for Erlotinib).
- Ignores the `screened_compounds_rel_8.4.csv` source of the drug list match.
- Does not route to the `gdsc` sub-skill.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
