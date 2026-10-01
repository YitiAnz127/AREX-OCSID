# Search -> info -> sequence chain for ACE2

## User Persona
A graduate student who knows the broad purpose of gget (query genomic databases)
but not the API. They want a guided, identifier-centered workflow to resolve a
gene symbol to a stable Ensembl ID, inspect its metadata, and get the protein
sequence.

## Scenario Coverage
- Skill area: `gene-annotation` (sub-skill of `gget`)
- Capability: `gget.search` + `gget.info` + `gget.seq` chained fast path
- Difficulty: basic
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/gene-annotation/SKILL.md`,
  `sub-skills/gene-annotation/references/api.md`
- Trigger expectation: The prompt is identifier-centered (search a symbol, get
  metadata, retrieve sequence) — the exact routing rule for `gene-annotation` in
  the root gget SKILL.md, which routes gene/transcript FASTA acquisition here.

## Expected Successful Behavior
- Routes to `gene-annotation`, not to sequence-tools or another sub-skill.
- Gives the fast path from SKILL.md: `gget.search("ace2", species="homo_sapiens", limit=5)`,
  then `gget.info(ens_id, ncbi=False, pdb=False, json=True)`, then
  `gget.seq(ens_id, translate=True)`.
- Explains `search` returns a DataFrame (or JSON with json=True), `info` returns
  metadata including `object_type`, `canonical_transcript`, `biotype`, and
  `seq` returns an alternating FASTA header/sequence Python list.
- Uses `translate=True` to request UniProt amino-acid records.

## Failure Signals
- Routes to sequence-tools or treats the task as a sequence-similarity job.
- Passes a gene symbol directly to `gget.seq` without first resolving an ID.
- Claims `seq` returns a DataFrame instead of a FASTA-line list.
- Points to the original gget source checkout rather than the public API.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
