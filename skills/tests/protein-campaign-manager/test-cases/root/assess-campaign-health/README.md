# Assess campaign health from QC metrics

## User Persona
A user who has completed backbone + sequence + validation stages and wants an automated health read on their resulting per-design QC metrics. They provide a CSV and rely on the skill's documented thresholds and health tiers. Intermediate level: they must run the documented `assess_campaign` logic and, importantly, classify an unhealthy campaign and diagnose the top issue rather than only reporting numbers.

## Scenario Coverage
- Skill area: root (`protein-campaign-manager`)
- Capability: campaign health assessment (pass-rate thresholds, health tiers, issue diagnosis)
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Fixture: `fixtures/results.csv` (10 designs; ipTM ~0.40-0.49 below 0.5, scRMSD mostly <2.0, pLDDT all >0.85)
- Expected references/scripts: `SKILL.md` (Campaign health assessment)
- Trigger expectation: QC-metrics pass-rate assessment over a campaign's result table routes to protein-campaign-manager.

## Expected Successful Behavior
- Applies the documented thresholds pLDDT>0.85, ipTM>0.5, scRMSD<2.0 and the composite all-pass rate.
- Computes per-rate and classifies health via the EXCELLENT/GOOD/MARGINAL/POOR tiers (>0.15 / >0.10 / >0.05 / else).
- With the fixture, reports overall pass rate 0.0 -> health POOR, ipTM pass rate ~0.0.
- Identifies the top issue as "Low ipTM - hotspot or interface issue" (iptm_pass < 0.20) and points to a hotspot/interface problem rather than a sequence/backbone-only issue.

## Failure Signals
- Reports only aggregate numbers without classifying against the documented health tiers.
- Uses thresholds different from pLDDT>0.85 / ipTM>0.5 / scRMSD<2.0.
- Fails to diagnose that the dominant failure is the ipTM (interface) metric, or misattributes it as a pLDDT/backbone issue.
- Hardcodes interpretation rather than reproducing the documented pass-rate computation.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
