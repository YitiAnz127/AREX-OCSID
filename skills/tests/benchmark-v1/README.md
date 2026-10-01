# Pilot Benchmark v1 (Step 2)

A frozen evaluation surface for the Agent-RSI loop over AREX-ocsid's repository
skills. This directory pins *which* skills are measured and *how* the
train/dev/held-out split is drawn. It does **not** claim any result — the
quality ledger and any downstream statistics live elsewhere and are produced
only after observations exist.

## Contents

| File | Role |
|---|---|
| `manifest.json` | Frozen `disco.benchmark.v1` manifest: 10 pilot skills split into train(4)/dev(3)/heldout(3), with split membership and case-tree content digests. |
| `skill-profiles.json` | The 109 classified repo-skills with a deterministic content-derived category, used as input to selection. Reproduction requires this exact file. |
| `../` (test-cases) | Per-skill `disco.usability-case.v1` case trees (43 cases). |

## How the pilot was selected (deterministic, reproducible)

1. `scripts/build_skill_profiles.py` reads the 109 `routing_status="classified"`
   repo-skills and classifies each by physical structure:
   `executable` (root `scripts/`), `workflow` (root `sub-skills/`, no scripts),
   `reference` (neither). Distribution: executable 56 / workflow 37 / reference 16.
2. `selectPilotSkills` (`cli/packages/coding-agent/src/benchmark/pilot.ts`)
   deterministically picks 10 skills, stratified so every present category is
   represented (FNV-1a-seeded round-robin — no external RNG).
3. `assignDeterministicSplits` + `buildManifest` (`src/benchmark/schema.ts`)
   freeze the split and compute the `splitHash`.

The whole selection + manifest is locked by
`src/benchmark/pilot.test.ts`, which additionally round-trips this committed
`manifest.json` to prove the `splitHash` is stable. `contentHash` covers every
file under each selected skill's `test-cases/` tree, including fixtures and
reviewer notes. `contentHashes` verifies each split independently so a
train/dev run never needs to read held-out case content.

## Honesty contract

- Nothing here is a conclusion about routing quality. The manifest only pins
  *measurement scope*.
- Test cases and their `assertions.json` are **evaluation artifacts with real
  evidence, never synthetic guesses**. Every pilot skill now has ≥3
  evidence-anchored `disco.usability-case.v1` cases (43 total across 10 skills),
  each with `evidence_basis` paths that physically exist in the source skill and
  whose assertions are derivable from the request plus the real skill files.
  These are validated by
  `scripts/tests/validate_benchmark_cases.py` (schema fields + real-path check).

## Next (Step 2 completion)

- Wire the observer's `task_judgement` events into the `disco.quality-ledger.v1`
  rows (done — `src/benchmark/ledger.ts` + `ocsid repo-skills ledger`) so
  `task_success_rate` becomes meaningful (non-null) once graded observations
  exist.
- Run a pilot evaluation pass: run each case through an agent, grade the
  response against the case's assertions, record the scores into the ledger, and
  only then compute per-skill / per-split success rates.
