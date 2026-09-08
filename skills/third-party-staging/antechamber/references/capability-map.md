# antechamber — Capability Map

| Capability | Tool / Route |
| --- | --- |
| Small-molecule / residue parameterization | `antechamber` (AmberTools) |
| Atom / bond typing | `-at gaff` / `-at gaff2` / `-at amber` |
| Charge generation | `-c bcc` / `-c resp` / `-c esp` / `-c gas` etc. |
| Charge import | `-c rc -cf <file>` |
| Format conversion | ac / mol2 / pdb / prepi / gout / orcinp / pdbqt / etc. |
| Input prep for downstream | mol2 / prepi → LEaP → AMBER MD |

## Prerequisites

- AmberTools installed, `antechamber` on `PATH`.

## Safety / Boundary

- Not for standard residues, metal complexes, inorganic systems.
- Not for pure quantum-chemistry geometry/energy runs (see quantum-chemistry skills).
- Not when no valid molecular structure exists (e.g. only SMILES).

## Troubleshooting

- `-a` additional-file atom-order mismatch → verify atom order matches input.
- Gasteiger charge ignores net charge → not suitable for charged molecules.
- RESP/ESP charge requires a Gaussian output/ESP file or GAMESS dat as input.
