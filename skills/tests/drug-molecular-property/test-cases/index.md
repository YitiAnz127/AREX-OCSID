# drug-molecular-property — Usability Test Cases

Index of usability test cases for the generated `drug-molecular-property` repo
skill.

`drug-molecular-property` (origin `DrugClaw/drug_molecular_property`, family Drug
Discovery and Development) has a single sub-skill `gdsc` that wraps the
`60_GDSC_GDSC2.py` script: `query_gdsc` for drug/target/cell-line lookups,
`download_gdsc_data`, the manual-download fallback, and the default `DATA_DIR`.
The root `SKILL.md` merely routes to `gdsc`. All capability evidence lives in
`sub-skills/gdsc/SKILL.md`.

## Case list

| Case | Area | User role | Scenario | Capability | Difficulty | Test emphasis |
|---|---|---|---|---|---|---|
| `sub-skills/gdsc/resolve-drug-target` | gdsc | novice oncologist | Query Erlotinib's molecular target and pathway | `query_gdsc` drug-target lookup + return format | basic | route discovery + workflow depth |
| `sub-skills/gdsc/multi-entity-dataframe` | gdsc | intermediate developer | Batch-query a mixed drug / gene-target / cell-line list | multi-entity `query_gdsc` + empty-list/no-match contract | intermediate | workflow depth + support workflow (return contract) |
| `integration/offline-data-dir-recovery` | integration (gdsc) | HPC debugging user | First-run auto-download fails with no internet; fix empty data dir | offline manual `wget` download + `DATA_DIR`/`GDSC_DATA_DIR` setup | troubleshooting | troubleshooting clarity + support workflow |

## Coverage note vs surface

The skill's entire user-facing surface is the single `gdsc` sub-skill. The three
cases cover its major routes: the primary happy-path query (resolve-drug-target),
a realistic batched/edge variant exercising the no-match contract
(multi-entity-dataframe), and the documented failure mode (empty data directory /
offline node). The `download_gdsc_data()` programmatic trigger and the
`ssl`/dependency note (openpyxl) are exercised inside the integration recovery
case rather than given a dedicated case, which is a negligible gap.

## Difficult-case coverage

- **Per-sub-skill difficult synthetic cases:** none above `gdsc`'s ordinary
  surface; the multi-entity case is the synthetic difficult variant — it
  combines mixed entity namespaces and the empty-match/error return contract
  grounded in `sub-skills/gdsc/SKILL.md`.
- **Integrated difficult cases:** `integration/offline-data-dir-recovery` — crosses
  root routing with gdsc data setup; synthesized from the gdsc SKILL.md (no
  separate native tests/examples tree is captured for this skill).
- **Original repo-native cases:** none — the skill's source snapshot has no
  separate tests/examples tree; all cases are synthesized from
  `sub-skills/gdsc/SKILL.md` and root `SKILL.md`.

## Assertion coverage

- Cases with `assertions.json`: 3 of 3.
- Capabilities with native repo evidence anchoring at least one assertion:
  `query_gdsc` single-entity and multi-entity calls, `SourceFileLoader` import,
  return JSON shape (source/match_count/matches), empty-list and `{"error":...}`
  contracts, default `DATA_DIR` + `GDSC_DATA_DIR` override, three manual `wget`
  URLs, `download_gdsc_data`.
- Capabilities covered only by synthetic assertions: none — every assertion is
  anchored to real SKILL.md text.
- Capabilities lacking assertions: none material.
- Cases with fixtures: none — no local input files are needed; all calls and
  download/recovery instructions are grounded in the documented GDSC dataset
  layout and URLs.
