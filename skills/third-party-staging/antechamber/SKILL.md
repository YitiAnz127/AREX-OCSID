---
name: antechamber
description: "Use for AmberTools antechamber tasks: parameterizing small molecules or non-standard residues into GAFF/AMBER-compatible chemical space by automating atom/bond typing, charge generation or import (RESP/AM1-BCC/ESP/etc.), and producing force-field-compatible mol2/prepi inputs for downstream LEaP."
disable-model-invocation: true
metadata:
  disco-role: operating
license: LGPL-3.0-or-later
---

# antechamber (AmberTools) Repo Skill

Use this repo skill when a task involves AMBER-based molecular mechanics and a small molecule or non-standard residue is not covered by standard force fields, or needs charge/atom-type assignment. It covers atom/bond typing, charge generation, and conversion of structures from upstream tools (pdb, mol2, ac, gout, etc.) into mol2/prepi formats ready for LEaP.

## Prerequisites

- Requires AmberTools installed and on `PATH`.

## Command Line Usage

```text
Usage: antechamber -i     input file name
                   -fi    input file format
                   -o     output file name
                   -fo    output file format
                   -c     charge method
                   -cf    charge file name
                   -nc    net molecular charge (int)
                   -a     additional file name
                   -fa    additional file format
```

- `-i`, `-fi`, `-o`, `-fo` must appear.
- `-a`, `-fa`, `-ao` read additional file info (WARNING: atom-order mismatch risk).
- `-rn` sets a custom residue name for readability.

### Charge generation

- `-c`: use when input lacks usable charges or charges need recalculation.
  - `-c bcc` recommended for general use; `-c resp` for higher accuracy (needs Gaussian output/ESP file).
- `-cf`: only when `-c rc` (read in charge).
- `-nc`: required when charge calculation runs and net charge ≠ 0.

### Atom type assignment

- `-at`: use when input lacks usable atom type info.
  - `-at gaff2` recommended for general use; `-at amber` for modified residues that must match standard AMBER force fields.

### File formats (index)

Antechamber (ac, 1), Sybyl Mol2 (mol2, 2), PDB (pdb, 3), Modified PDB (mpdb, 4), AMBER PREP int/car (prepi 5 / prepc 6), Gaussian Z-Matrix (gzmat 7), Gaussian Cartesian (gcrt 8), Mopac Internal (mopint 9), Mopac Cartesian (mopcrt 10), Gaussian Output (gout 11), Mopac Output (mopout 12), CSD (csd 14), MDL (mdl 15), AMBER Restart (rst 17), Orca input/output (orcinp 29 / orcout 30), pdbqt (31).

### Charge methods (index)

RESP (resp, 1), AM1-BCC (bcc, 2), CM1 (cm1, 3), CM2 (cm2, 4), ESP Kollman (esp, 5), Mulliken (mul, 6), Gasteiger (gas, 7), ABCG2 (abcg2, 8), Read in (rc, 9), Write out (wc, 10), Delete (dc, 11).

## Common Examples

### Convert antechamber format → Sybyl Mol2

```bash
antechamber -i input.ac -fi ac -o output.mol2 -fo mol2
```

### Convert PDB → Mol2, AM1-BCC charges (net −1), GAFF2 atom types

```bash
antechamber -i input.pdb -fi pdb -o output.mol2 -fo mol2 -c bcc -nc -1 -at gaff2
```

### Convert Gaussian output → Mol2, RESP charges, GAFF2 types

```bash
antechamber -i input.gout -fi gout -o output.mol2 -fo mol2 -c resp -at gaff2
```

### Convert antechamber format → Mol2, assign AMBER atom types, rename residue LIG

```bash
antechamber -i input.ac -fi ac -o output.mol2 -fo mol2 -at amber -rn LIG
```

## Route Here

- Task is about: AMBER / AmberTools / force-field parameterization / GAFF / atom typing / RESP / AM1-BCC / small-molecule prep / mol2 / prepi.
- Needs a runnable AmberTools `antechamber` executable; do not fake chemistry — run the tool.

## Boundary / Not Here

- Standard AMBER residues or already-parameterized systems → use other AMBER/force-field skills.
- Pure quantum chemistry (Gaussian/Orca runs) → see quantum-chemistry skills.
- Do NOT use when no valid molecular structure is available (e.g. only SMILES), or for metal complexes / inorganic systems.

## References

- [antechamber Documentation](https://ambermd.org/antechamber/ac.html)
- [AmberTools](https://ambermd.org/AmberTools.php)
