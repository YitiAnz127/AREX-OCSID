# Debug fetch failures, multiple models, and gapped residues

## User Persona
A user debugging a concrete failure. They are experienced enough to name Bio.PDB, interface-residue scanning, and NMR models, but the failure mode is not obvious to them. This forces the skill to surface the documented troubleshooting entries rather than only happy-path code.

## Scenario Coverage
- Skill area: root (`pdb-structure`)
- Capability: troubleshooting (fetch failure, multi-model selection, missing residues, interface scan)
- Difficulty: troubleshooting
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (Troubleshooting, Structure Analysis / find_interface_residues)
- Trigger expectation: PDB fetch errors, model handling, residue gaps, and interface analysis are all within pdb-structure scope, and the prompt lists concrete error symptoms.

## Expected Successful Behavior
- Identifies that "1abcD" is an invalid PDB ID because a valid ID is exactly 4 characters, and shows the correct 4-char form plus the documented `curl`/`PDBList` fetch path.
- Explains that when multiple models are present the first model should be selected for design.
- Explains how missing/gapped residue numbers affect the residue iterator and that gaps should be checked before interface analysis.
- Provides the `find_interface_residues` pattern with a distance cutoff (4.0 default) between two chains and returns the two residue sets.

## Failure Signals
- Retries the same 5-char ID instead of diagnosing the format.
- Ignores the multiple-model issue or selects a random model.
- Produces an interface scan that iterates every model instead of the selected one, or omits the distance cutoff.
- Advises opening files from the original source checkout or editing installed Bio.PDB source.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
