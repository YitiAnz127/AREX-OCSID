# Mutation FASTA/table join preflight

## User Persona
An intermediate biologist/developer who has a FASTA and a mutation TSV and wants
a safe, read-only validation before running `gget.mutate`. They explicitly want
to know about any row that will not join and how gget normalizes IDs. They
provide two small local files in `fixtures/`.

## Scenario Coverage
- Skill area: `specialized-workflows` (sub-skill of `gget`)
- Capability: `gget.mutate` input preflight via the bundled
  `scripts/validate_mutation_inputs.py` + sequence-ID join normalization
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Fixtures: `fixtures/transcripts.fa`, `fixtures/mutations.tsv`
- Expected references/scripts: `sub-skills/specialized-workflows/SKILL.md`,
  `sub-skills/specialized-workflows/references/mutation-contract.md`,
  `sub-skills/specialized-workflows/scripts/validate_mutation_inputs.py`
- Trigger expectation: The prompt is a mutation-generation workflow including a
  FASTA/table pair — the documented `specialized-workflows` (mutate) route, and
  it explicitly asks the agent to use a read-only validation preflight.

## Expected Successful Behavior
- Routes to `specialized-workflows`, not `disease-structure` (mutate is sequence
  transformation, not cancer lookup).
- Runs the bundled read-only helper
  `python scripts/validate_mutation_inputs.py --fasta fixtures/transcripts.fa --mutations fixtures/mutations.tsv --mut-column mutation --seq-id-column seq_ID`.
- Reads the JSON report: 3 FASTA records, 3 mutation rows, 2 matched rows, and
  `unmatched_sequence_ids: ["ENSM1"]`.
- Explains gget's FASTA join normalization: first token of the title, then the
  portion before the first dot (so `ENST1` from `>ENST1.4 description`), and that
  the unmatched `ENSM1` row is an input error — it must be fixed, not guessed.
- Does not mutate files, and the script's `read_only: True` is emphasized.

## Failure Signals
- Routes to `disease-structure` or runs `gget.cosmic`/`mutate` as a cancer lookup.
- Runs the transformation without validating, or overwrites the user's files.
- Misstates the normalize rule (e.g. keeps the dot version `ENST1.4`).
- Treats the unmatched row as permission to guess a join.
- Points at the original gget source checkout instead of the bundled helper.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
