# drug-combination — Usability Test Cases

Index of usability test cases for the generated `drug-combination` repo skill.

`drug-combination` is a **two-sub-skill** repo skill: `drugcomb` (DrugComb
summary data: pattern-based entity search, `synergy_zip`/`synergy_bliss` on
`drug_row`/`drug_col`/`cell_line_name`) and `drugcombdb` (canonical DrugCombDB
records: `Drug1`/`Drug2`/`Cell`, `Synergy`, `SynergyType`, `PMID`). Both
sub-skills expose their query API tables directly in their `SKILL.md`; no
bundled scripts live inside this skill directory (the referenced `example.py`
and `resources_metadata/...` paths are external to the generated skill and are
not copied here). Evidence is therefore anchored to the two sub-skill
`SKILL.md` files.

## Case list

| Case | Area | User role | Scenario | Capability | Difficulty | Test emphasis |
|---|---|---|---|---|---|---|
| `sub-skills/drugcomb/drug-and-cellline-synergy-summary` | drugcomb | researcher (basic) | Search DrugComb by drug name (5-FU) and cell line (MCF-7), summarize zip/bliss synergy | pattern-based drug/cell-line search + summarize | basic | route discovery + API specificity |
| `sub-skills/drugcombdb/canonical-drug-pair-synergy-query` | drugcombdb | researcher (intermediate) | Query canonical DrugCombDB drug-pair record, cap result limit, return Synergy/SynergyType/PMID | canonical DrugCombDB pair query + limit | intermediate | API specificity + support workflow |
| `integration/cross-database-synergy-comparison` | integration (drugcomb + drugcombdb) | advanced researcher | Cross-check one combination across both databases, compare schemas | cross-database schema differentiation + reconciliation | advanced | cross-sub-skill integration + schema disambiguation |

## Coverage note vs surface

Both sub-skills are covered: `drugcomb` has a happy-path search case;
`drugcombdb` has a pair-query case; the integration case exercises routing
across both sources and the schema difference between them. Each of the two
major public capabilities (DrugComb summary search; DrugCombDB canonical
query) has at least one dedicated case. No material coverage gap.

## Difficult-case coverage

- **Per-sub-skill difficult synthetic cases:**
  - `drugcombdb/canonical-drug-pair-synergy-query` (intermediate) extends the
    drugcombdb API evidence with a result-limit and canonical-schema requirement.
  - `drugcomb/drug-and-cellline-synergy-summary` (basic) anchors the pattern
    table (drug name substring vs cell-line substring) to the drugcomb SKILL.md.
- **Integrated difficult case:** `integration/cross-database-synergy-comparison`
  crosses `drugcomb` and `drugcombdb` and forces schema disambiguation;
  synthesized from the two sub-skill `SKILL.md` files.
- **Original repo-native cases:** none — no captured repo-native tests tree
  exists in this generated skill; all cases are synthesized from the sub-skill
  `SKILL.md` evidence.

## Assertion coverage

- Cases with `assertions.json`: 3 of 3.
- Capabilities with native repo evidence anchoring at least one assertion:
  DrugComb pattern-based search + summarize + `synergy_zip`/`synergy_bliss`;
  DrugCombDB `search_drug_pair`/`search` + `Drug1`/`Drug2`/`Cell`/
  `Synergy`/`SynergyType`/`PMID`; schema differentiation across the two sources.
- Capabilities covered only by synthetic assertions: same set — anchored to the
  two sub-skill `SKILL.md` files.
- Capabilities lacking assertions: none material.
- Cases with fixtures: none (queries operate on data the user reports as loaded;
  no bundled sample CSV is needed to exercise the API-contract assertions).
