# alphafold3-pytorch — usability test-cases

Evidence-anchored `disco.usability-case.v1` cases for the `alphafold3-pytorch`
repo-skill. Every `evidence_basis` / `expected_skill_files` path below exists in
`skills/repositories/repo-skills/alphafold3-pytorch/`. No assertion is invented
beyond what the skill's real files document; all are derivable from the request
plus the listed skill files.

## Case list

| area | case | target_capability | difficulty | role |
|---|---|---|---|---|
| sub-skills/cli-serving | multimolecule-command-preflight | cli-safe-multimolecule-command-preflight | intermediate | operator |
| sub-skills/model-inference | reduced-cpu-smoke-contract | bounded-model-inference-contract-probe | basic | maintainer |
| sub-skills/data-pipeline | layout-preflight-validation | data-layout-preflight-without-mutation | troubleshooting | data engineer |

## Coverage notes

- `cli-serving`, `model-inference`, and `data-pipeline` are three of the five
  sub-skills. The other two (`input-representation`, `training-configuration`)
  are not given dedicated cases here; they are referenced from the routing
  boundaries in the case README/specs where relevant.
- Difficult/troubleshooting coverage: the `data-pipeline` case is a
  troubleshooting scenario (unsafe acquisition boundary); the others exercise
  basic/intermediate operation of real bundled helpers.

## Assertion coverage

- 3/3 cases have `assertions.json` with non-empty assertions.
- Every assertion is anchored to a real bundled file: `build_cli_command.py`,
  `smoke_model.py`, `validate_data_layout.py` and their references.
- No fixtures are used; all cases are model-of-the-runtime style (no network,
  no weights, no large data).
