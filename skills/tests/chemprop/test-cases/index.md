# chemprop — Usability Test Cases

Index of usability test cases for the generated `chemprop` (2.2.3) repo skill.

`chemprop` is a **multi-sub-skill** repo skill with six sub-skills: `training-cli`,
`prediction-fingerprints`, `data-featurization`, `python-api-modeling`,
`specialized-molecular-tasks`, and `uncertainty-advanced`. Cases cover the major
routable surfaces (training, prediction/fingerprint, data validation, uncertainty)
plus one cross-sub-skill integration case. Two of the six major sub-skills
(`specialized-molecular-tasks`, `python-api-modeling`) are exercised indirectly
through the integration case and routed references rather than dedicated cases;
this is noted as a coverage gap below.

## Case list

| Case | Area | User role | Scenario | Capability | Difficulty | Test emphasis |
|---|---|---|---|---|---|---|
| `sub-skills/training-cli/multicomponent-binary-classification` | training-cli | intermediate (knows task, not CLI) | Train multi-endpoint binary classifier, pick metrics/tracking/class-balance/split | classification `chemprop train` command | intermediate | route discovery + workflow depth + bundled script |
| `sub-skills/training-cli/two-csv-trainval-test-debug` | training-cli | debugging user | Two CSV files; test-split error; need `--split-sizes 0.9 0.1 0.0` rule | two/three file split diagnosis | troubleshooting | troubleshooting clarity + support workflow |
| `sub-skills/prediction-fingerprints/ensemble-predict-and-fingerprint` | prediction-fingerprints | intermediate/advanced | Ensemble predict (directory models, averaged + per-model) and fingerprint with ffn-block-index | multi-model predict + fingerprint export | intermediate | workflow depth + bundled script executability |
| `sub-skills/data-featurization/multicomponent-npz-row-mismatch` | data-featurization | debugging user (support) | Component-indexed descriptor NPZ row mismatch; preflight with validator | data/input validation (NPZ alignment) | troubleshooting | support-workflow discoverability + fixtures |
| `sub-skills/uncertainty-advanced/regression-mve-calibration` | uncertainty-advanced | advanced user | MVE prediction with zscaling calibration, evaluation methods, conformal alpha | prediction-time uncertainty/calibration/conformal | advanced | workflow depth + API/flag specificity |
| `integration/python-api-train-then-predict` | integration (python-api-modeling → prediction-fingerprints) | maintainer/advanced | Hand-write MPNN in Python API, train on CPU, save, then predict via CLI | Python API modeling + prediction handoff | advanced | cross-sub-skill integration + bundled script |

## Coverage note vs surface

Six sub-skills exist. Training, prediction/fingerprint, data validation, and
uncertainty each have at least one dedicated case. `python-api-modeling` is
covered by the integration case (which crosses it with prediction). The
`specialized-molecular-tasks` sub-skill (reaction SMILES, MolAtomBond
atom/bond targets, spectral tasks, reaction-plus-solvent multicomponent,
constraints) has **no dedicated case** in this set — it is the main coverage
gap. Future cases should add e.g. a reaction-mode training case and a
MolAtomBond atom/bond-target case under `sub-skills/specialized-molecular-tasks/`.

## Difficult-case coverage

- **Per-sub-skill difficult synthetic cases:**
  - `training-cli/two-csv-trainval-test-debug` (troubleshooting) extends the
    two-CSV split evidence from `training-cli` SKILL.md + `data-formats.md` +
    `chemprop_train_command_builder.py`.
  - `data-featurization/multicomponent-npz-row-mismatch` (troubleshooting)
    extends the component-indexed descriptor evidence from
    `data-featurization` SKILL.md + `extra-features-descriptors.md` +
    `validate_chemprop_tabular_inputs.py`.
  - `uncertainty-advanced/regression-mve-calibration` (advanced) extends the
    MVE/zscaling/conformal evidence from `uncertainty-advanced` SKILL.md +
    `uncertainty.md` + `chemprop_uncertainty_args.py`.
  - All three are synthesized from bundled references/scripts, not copied from
    repo-native tests.
- **Integrated difficult case:** `integration/python-api-train-then-predict`
  crosses `python-api-modeling` and `prediction-fingerprints`; synthesized from
  `chemprop_api_smoke.py` + `python-api-modeling` refs + `prediction-fingerprints`
  SKILL.md.
- **Original repo-native cases:** none imported directly; this generated skill
  does not ship a captured repo-native tests tree, so all cases are synthesized
  from bundled references/scripts.

## Assertion coverage

- Cases with `assertions.json`: 6 of 6.
- Capabilities with native repo evidence anchoring at least one assertion:
  classification `chemprop train` flags, tracking-metric/`class-balance` rules,
  two-file split rule, directory `.pt` model discovery, per-model individual
  outputs, fingerprint `ffn-block-index` + model-index naming, component-indexed
  descriptor mapping, NPZ row-count alignment, MVE `uncertainty-method`,
  `zscaling` calibration, `evaluation-methods` target requirement, conformal
  alpha, Python API `MoleculeDataset`/`MPNN`/`save_model`, and prediction handoff.
- Capabilities covered only by synthetic assertions: same set as above — the
  evidence basis is the bundled skill references and scripts, which are
  themselves distilled from Chemprop source/tests.
- Capabilities lacking assertions: `specialized-molecular-tasks` (reaction /
  MolAtomBond / spectral) has no dedicated case or assertion — coverage gap.
- Cases with fixtures: `data-featurization/multicomponent-npz-row-mismatch`
  ships `fixtures/multicomponent.csv` (4-row solute/solvent/target) so the
  validator's row-count-vs-CSV check can be exercised concretely; the descriptor
  NPZ is described as one row short in-world rather than stored as a binary
  fixture.
