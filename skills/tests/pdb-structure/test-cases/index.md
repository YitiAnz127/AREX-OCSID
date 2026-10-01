# pdb-structure — Usability Test Cases

Index of usability test cases for the generated `pdb-structure` repo skill.

`pdb-structure` is a **single-root skill** (no sub-skills, no bundled scripts).
Its full surface area lives in the root `SKILL.md`: fetching structures (curl,
Bio.PDB `PDBList`, RCSB API), structure preparation (chain select + trim),
PDB searching (full-text and sequence), structure analysis (chain info +
interface residues), a binder-design preparation checklist, and a short
troubleshooting block. All cases therefore live under `root/`.

## Case list

| Case | Area | User role | Scenario | Capability | Difficulty | Test emphasis |
|---|---|---|---|---|---|---|
| `root/fetch-and-analyze-kinase` | root | novice (knows goal, not API) | Fetch 1M17, report chain counts, produce full-text search query | fetch + chain analysis + search query | basic | route discovery + workflow depth |
| `root/prepare-binder-target` | root | intermediate designer | Select chain A then trim to binding region with buffer for RFdiffusion | chain select + trim + prep checklist | intermediate | workflow depth + support workflow |
| `root/debug-fetch-models-gaps` | root | debugging user | Diagnose invalid 5-char PDB ID, multi-model selection, gapped residues, interface scan cutoff | troubleshooting (fetch/models/gaps/interface) | troubleshooting | troubleshooting clarity |

## Coverage note vs surface

`pdb-structure` has a single root workflow surface. The three cases cover the
major user-facing routes: fetching, preparation, and troubleshooting. The search
APIs (full-text and sequence similarity) are exercised inside the first case's
search-query part and the RCSB API fetch path is covered there. The sequence
similarity query is not given its own dedicated case because it is a minor
variant of the same search request shape; it is noted here as a low-risk gap.

## Difficult-case coverage

- **Per-sub-skill difficult synthetic cases:** none — `pdb-structure` has no sub-skills.
- **Integrated difficult cases:** none — single-root skill; no cross-sub-skill integration surface exists.
- **Original repo-native cases:** all three cases are synthesized from the root
  `SKILL.md` evidence. There is no separate repo-native tests/examples tree
  captured for this skill.

## Assertion coverage

- Cases with `assertions.json`: 3 of 3.
- Capabilities with native repo evidence anchoring at least one assertion:
  fetch-by-ID (curl / PDBList / RCSB API URL), full-text search JSON,
  chain-info analysis, chain-select + trim, target-prep checklist, PDB ID
  format troubleshooting, multi-model selection, gap checking, interface scan.
- Capabilities covered only by synthetic assertions: none — every assertion is
  anchored to `SKILL.md` text.
- Capabilities lacking assertions: none material.
- Cases with fixtures: none (no local input files needed; all fetch/parse is
  anchored to real PDB/API evidence).
