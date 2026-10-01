# Locate an ambiguous DNA-only peptide with BLAT

## User Persona
An intermediate bioinformatics developer who knows the task (locate a sequence
on a genome) but is aware of a subtlety: their query looks like DNA yet is a
peptide, so automatic type detection would misfire. They need an explicit-type
BLAT call and careful assembly/output interpretation.

## Scenario Coverage
- Skill area: `sequence-tools` (sub-skill of `gget`)
- Capability: `gget.blat` with explicit `seqtype` and assembly, output-column interpretation
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/sequence-tools/SKILL.md`,
  `sub-skills/sequence-tools/references/api-reference.md`,
  `sub-skills/sequence-tools/references/workflows.md`
- Trigger expectation: The prompt asks to place a sequence on a genome with
  BLAT — the documented `sequence-tools` surface — and forces explicit
  nucleotide/protein disambiguation and `genome` column checking.

## Expected Successful Behavior
- Routes to `sequence-tools`, not `gene-annotation`.
- Sets `seqtype="protein"` explicitly and `assembly="mouse"` (which maps to
  `mm39`), passing the literal sequence.
- Explains the returned normalized columns from api-reference.md
  (`genome, query_size, ... %_matched, chromosome, strand, start, end`) and to
  inspect the `genome` value because an unrecognized assembly can fall back to
  UCSC's default genome.
- Notes the 8,000-character truncation limit and that a very short input can
  legitimately return `None`.
- Preserves the returned table rather than only printing a message.

## Failure Signals
- Lets auto-detection classify the DNA-only peptide as nucleotide and runs
  `blastn`/BLAT-DNA by mistake.
- Inventing a `genome` column check or assembly mapping not in the reference.
- Routes the task to `gene-annotation` (which is for ID/FASTA work, not BLAT).
- Tells the user to open the original gget source files.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
