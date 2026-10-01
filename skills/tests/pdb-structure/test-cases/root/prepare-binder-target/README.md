# Prepare a binder-design target (chain select + trim)

## User Persona
An intermediate protein designer who already has a downloaded complex PDB and wants to prepare a clean, trimmed binder target. They know the RFdiffusion workflow by name and name specific residues, but need the concrete pdb-structure API usage (Bio.PDB Select subclasses) and the documented preparation checklist.

## Scenario Coverage
- Skill area: root (`pdb-structure`)
- Capability: structure preparation (chain selection + trimming to binding region)
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (Structure Preparation, Common Tasks for Binder Design)
- Trigger expectation: PDB handling, chain selection, trimming to a binding region, and the binder-design prep checklist all route to pdb-structure.

## Expected Successful Behavior
- Uses a `Bio.PDB` `Select` subclass overriding `accept_chain` to keep chain A and `PDBIO.save(..., ChainSelect("A"))`.
- Gives a `trim_around_residues` style routine: parse with PDBParser, compute the mean coordinate over the specified center residues, then a `Select` that keeps residues with any atom within the buffer.
- Splits the requests into two distinct steps (chain select first, then trim) and then applies the documented Target Preparation Checklist order: download -> identify target chain -> remove waters/ligands -> trim to binding region + buffer -> identify hotspots -> renumber if needed.

## Failure Signals
- Provides only shell commands with no Bio.PDB chain-selection or trimming logic.
- Omits the actual `accept_chain` / `accept_residue` overrides that the skill documents.
- Confuses the residue coordinate buffer logic (e.g. trimming by residue index instead of by distance to a center).
- Tells the user to open example files from the original source repo.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
