# Fetch and analyze an EGFR kinase structure

## User Persona
A novice-to-intermediate protein designer who knows the broad purpose (prepare a target for binder design) but is NOT familiar with the pdb-structure skill's specific API. They know they have a machine with Biopython and requests available but otherwise rely on the agent.

## Scenario Coverage
- Skill area: root (`pdb-structure`)
- Capability: PDB fetch by ID + structure analysis (chain info) + RCSB Search API full-text query
- Difficulty: basic
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (Fetching Structures, Searching PDB, Structure Analysis)
- Trigger expectation: The prompt names protein structures, PDB IDs, EGFR kinase, Biopython, and RCSB Search — direct triggers for `pdb-structure`.

## Expected Successful Behavior
- Routes to pdb-structure, does not route elsewhere.
- Uses `curl -o <id>.pdb https://files.rcsb.org/download/<ID>.pdb` or `PDBList().retrieve_pdb_file` / the RCSB API `fetch_pdb` pattern for 1M17.
- Produces chain info (chain id, length, first/last residue) using the `get_structure_info` pattern.
- Provides the full-text RCSB Search query returning `service: "full_text"` with `value: "EGFR kinase domain"` and `return_type: "entry"`.

## Failure Signals
- Tells the user to open files from the original protein-design-skills checkout.
- Gives generic advice without reproducing the real PDB download URL, PDBList call, or the full-text search JSON shape.
- Uses a wrong API name or URL that is not present in the skill evidence (e.g. an invented endpoint).
- Fails to mention PDB ID normalization (4-char uppercase).

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
