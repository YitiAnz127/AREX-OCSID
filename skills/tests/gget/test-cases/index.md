# gget — Usability Test Cases

Index of usability test cases for the generated `gget` repo skill.

`gget` is a Python/CLI wrapper library with five sub-skills routed by the
user's goal: `gene-annotation` (ref/search/info/seq), `sequence-tools`
(blast/blat/muscle/diamond/elm/pdb/alphafold), `expression-omics`
(archs4/bgee/cellxgene/8cube), `disease-structure` (enrichr/cbio/cosmic/
opentargets/g2p), and `specialized-workflows` (virus/mutate/setup/gpt). The root
`SKILL.md` installs/inspects first (via `scripts/check_install.py`) and routes by
goal episode. Seven cases cover the major surfaces plus root troubleshooting and
a cross-capability integration.

## Case list

| Case | Area | User role | Scenario | Capability | Difficulty | Test emphasis |
|---|---|---|---|---|---|---|
| `sub-skills/gene-annotation/search-info-seq-chain` | gene-annotation | novice student | Resolve ACE2 symbol -> info metadata -> protein sequence | search/info/seq identifier chain | basic | route discovery + workflow depth |
| `sub-skills/sequence-tools/blat-genome-location` | sequence-tools | intermediate dev | Locate an ambiguous DNA-only peptide on the mouse genome with explicit protein type | blat explicit type + assembly + genome-column check | intermediate | workflow depth + support workflow (input discipline) |
| `sub-skills/disease-structure/enrichr-ensembl-background` | disease-structure | advanced analyst | Enrichr with versioned Ensembl IDs + explicit ensembl background + reproducible top-N | enrichr ensembl conversion + ensembl_bkg + top-N | advanced | difficult synthetic + API specificity |
| `sub-skills/expression-omics/archs4-tissue-correlation` | expression-omics | novice biologist | STAT4 correlation + mouse tissue atlas + invalid-arg contract | archs4 correlation + tissue atlas | basic | route discovery + workflow depth |
| `sub-skills/specialized-workflows/mutation-preflight` | specialized-workflows | intermediate dev | Read-only preflight of a FASTA/TSV mutation join before gget.mutate | mutate input validation + ID normalization | intermediate | bundled-script executability + support workflow |
| `root/install-version-diagnostic` | root | novice/intermediate | Diagnose ModuleNotFoundError / wrong version / shadowed gget | install/version/CLI read-only diagnostic | troubleshooting | troubleshooting clarity + self-containment |
| `integration/opentargets-g2p-join` | integration | advanced analyst | Open Targets disease rows -> G2P residue features with explicit UniProt join and portal-only boundary | opentargets + g2p cross-capability | advanced | integrated difficult + troubleshooting of boundaries |

## Coverage note vs surface

The route matrix in root `SKILL.md` lists five sub-skills. Each has at least one
case: gene-annotation, sequence-tools, disease-structure, expression-omics, and
specialized-workflows are all exercised. `ref`/`seq` (gene-annotation) and
`blast`/`muscle`/`diamond`/`elm`/`pdb`/`alphafold` (sequence-tools) share the
same routing as the covered fast paths; they are not each given a dedicated case,
which is a low-risk gap given the shared input/output discipline documented in
`references/api-overview.md`. `cellxgene`/`bgee`/`8cube` (expression-omics) and
`virus`/`setup`/`gpt` (specialized-workflows) are represented through the
routing/boundary rules surfaced in the covered cases and the root operational
rules rather than their own prompts.

## Difficult-case coverage

- **Per-sub-skill difficult synthetic cases:**
  - `sequence-tools` (`blat-genome-location`): extends native BLAT evidence
    (`api-reference.md`/`workflows.md`) by combining an ambiguous DNA-only
    peptide, explicit type selection, and the unrecognized-assembly `genome`
    fallback check.
  - `disease-structure` (`enrichr-ensembl-background`): the SKILL.md-flagged
    difficult case — versioned Ensembl IDs, ensembl background, and reproducible
    top-N atop `enrichr.md`.
  - `specialized-workflows` (`mutation-preflight`): exercises the bundled
    executable `validate_mutation_inputs.py` with small fixtures and the ID-join
    contract from `mutation-contract.md`.
- **Integrated difficult cases:** `integration/opentargets-g2p-join` — crosses
  `opentargets` and `g2p` capabilities; synthesized from the documented synthetic
  case in `opentargets.md`/`g2p.md` (origin `pachterlab/gget` has no captured
  tests/examples tree in this skill snapshot).
- **Original repo-native cases:** none — this repo-skill snapshot does not carry a
  separate tests/examples tree; every case is synthesized from real SKILL.md /
  reference text and the bundled scripts.

## Assertion coverage

- Cases with `assertions.json`: 7 of 7 (one, `mutation-preflight`, also has a
  `fixtures/` directory).
- Capabilities with native repo evidence anchoring at least one assertion:
  install/CLI check (`scripts/check_install.py`, `references/troubleshooting.md`);
  `search`/`info`/`seq` fast path and signatures (`gene-annotation/*`);
  BLAT type/assembly/columns (`sequence-tools/api-reference.md`); Enrichr
  Ensembl conversion, columns, background (`disease-structure/enrichr.md`);
  ARCHS4 correlation/tissue and failure contract (`expression-omics/workflows.md`);
  mutate preflight and ID normalization (`specialized-workflows/validate_mutation_inputs.py`,
  `mutation-contract.md`); Open Targets + G2P schemas and portal-only boundary.
- Capabilities covered only by synthetic assertions: none — every assertion maps
  to documented text or the bundled scripts.
- Capabilities lacking assertions: `ref` and `seq` codon variants, `blast`/
  `muscle`/`diamond`/`elm`/`pdb`/`alphafold`, `cellxgene`/`bgee`/`8cube`,
  `virus`/`setup`/`gpt` (listed as low-risk routing gaps above; not given
  dedicated cases).
- Cases with fixtures: `mutation-preflight` uses `fixtures/transcripts.fa` and
  `fixtures/mutations.tsv` to exercise the read-only join validation — a deliberately
  unmatched row (`ENSM1`) tests that the helper flags a join that would fail.
