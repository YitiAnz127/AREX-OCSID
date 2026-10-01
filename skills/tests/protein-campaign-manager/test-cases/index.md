# protein-campaign-manager — Usability Test Cases

Index of usability test cases for the generated `protein-campaign-manager` repo skill.

`protein-campaign-manager` is a **single-root skill** (no sub-skills, no bundled
scripts). Its full surface lives in the root `SKILL.md`: goal-to-pipeline
planning, the complete pipeline generator with concrete rfdiffusion
/ProteinMPNN command strings, campaign size recommendations, the tool-selection
guide and target-difficulty assessment, the campaign health assessment
(`assess_campaign` with pLDDT/ipTM/scRMSD thresholds and health tiers), cost
estimation, and pipeline variants. All cases live under `root/`.

## Case list

| Case | Area | User role | Scenario | Capability | Difficulty | Test emphasis |
|---|---|---|---|---|---|---|
| `root/plan-standard-binder-campaign` | root | novice (knows goal, not API) | Plan a 10-binder campaign: pipeline, sizing, cost, yield, commands | goal-to-pipeline planning | basic | route discovery + workflow depth |
| `root/assess-campaign-health` | root | workflow user | Run health check on a QC CSV with a low-ipTM fixture | campaign health assessment | intermediate | support workflow + troubleshooting clarity |
| `root/difficult-target-tool-selection` | root | experienced designer | Pick tool + pipeline variant for a difficult flexible target with a POOR pass rate | target-difficulty + tool selection + variants | advanced | workflow depth + edge case |

## Coverage note vs surface

The root skill has three major user-facing workflow areas: (1) planning a
campaign end-to-end, (2) assessing campaign health from results, and (3)
selecting tools/variants for nonstandard or difficult goals. Each has a
dedicated case. The cost-estimation tables and the quick-exploration variant
are secondary; cost is exercised inside the planning case and the quick
exploration variant is covered by the modern-variant set in the third case.
Sequence-similarity and ESM2 PLL filtering are noted as sub-capabilities of the
pipeline generator exercised through the standard planning case.

## Difficult-case coverage

- **Per-sub-skill difficult synthetic cases:** none — no sub-skills.
- **Integrated difficult cases:** none — single-root skill; no cross-sub-skill surface.
- **Original repo-native cases:** the second and third cases are synthesized
  from root `SKILL.md` evidence. The third case is deliberately synthetic: it
  combines difficulty classification, tool selection, and both variant command
  sets beyond any single original example. The first case closely follows the
  documented "10 binders for EGFR" planning block.

## Assertion coverage

- Cases with `assertions.json`: 3 of 3.
- Capabilities with native repo evidence anchoring at least one assertion:
  pipeline recommendation, campaign sizing (500/4000), rfdiffusion command,
  ProteinMPNN loop + checkpoint, time/cost/yield, health thresholds + tiers,
  low-ipTM diagnosis, target-difficulty indicators, tool-selection table,
  high-throughput/high-quality variant parameters.
- Capabilities covered only by synthetic assertions: none — every assertion is
  anchored to `SKILL.md`.
- Capabilities lacking assertions: none material.
- Cases with fixtures: `root/assess-campaign-health` ships `fixtures/results.csv`
  (10 small numeric rows) to exercise the documented quantity-threshold and
  health-tier logic on a low-ipTM result set.
