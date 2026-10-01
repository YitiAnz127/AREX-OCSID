# mosaic — Usability Test Cases

Index of usability test cases for the generated `mosaic` repo skill.

`mosaic` (origin `protein-design-skills/mosaic`, family Protein Modeling) is a
**single-root skill with no sub-skills**. Its full surface lives in `SKILL.md`:
when to use Mosaic vs bindcraft, install, composing `LossTerm` objects into a
multi-objective design loss, the optimizer set (`simplex_APGM`, `batched_simplex_APGM`,
`gradient_MCMC`) with the `0.1 * sqrt(binder_length)` step-size heuristic, the
Boltz-2 multi-sample ipTM/ipSAE ranking workflow, a troubleshooting table, and a
decision tree. All cases therefore live under `root/`.

## Case list

| Case | Area | User role | Scenario | Capability | Difficulty | Test emphasis |
|---|---|---|---|---|---|---|
| `root/compose-multiobjective-loss` | root | intermediate designer | Build a custom binder-objective from LossTerm terms + choose optimizer/step size | compose multi-objective loss | basic | route discovery + workflow depth |
| `root/ipsae-ranking-boltz2` | root | advanced user | Rank Boltz-2 designs with the multi-sample ipTM/ipSAE loss | Boltz2 `build_multisample_loss` ranking | advanced | difficult synthetic + API specificity |
| `root/debug-unstable-optimization` | root | debugging user | Diagnose failing designs, unstable optimization, JIT slowness, OOM | troubleshooting objective/step-size/predictors | troubleshooting | troubleshooting clarity |
| `root/choose-custom-vs-bindcraft` | root | intermediate chooser | Decide Mosaic vs bindcraft / boltzgen / rfdiffusion via the decision tree | decision-tree routing | intermediate | route discovery (borderline trigger) |

## Coverage note vs surface

`mosaic` has no sub-skills, so its entire surface is the root `SKILL.md`. The four
cases cover every primary user-facing facet: objective composition (the core
idea), the expert ranking workflow, the troubleshooting table, and the
decision-tree routing boundary. Install/JAX prerequisites and the `simplex_APGM`
step-size heuristic are exercised inside `compose-multiobjective-loss`; the
install instructions and cost notes are not given a dedicated case (a negligible
gap — they are boilerplate covered by the composed-run case).

## Difficult-case coverage

- **Per-sub-skill difficult synthetic cases:** none — `mosaic` has no sub-skills.
- **Integrated difficult cases:** none — single-root skill; no cross-sub-skill
  integration surface exists. `ipsae-ranking-boltz2` is the intentionally
  difficult case, synthesized from the SKILL.md worked-example (the source
  snapshot carries no separate tests/examples tree).
- **Original repo-native cases:** none — the skill snapshot does not carry a
  tests/examples tree; all cases are synthesized from real `SKILL.md` text.

## Assertion coverage

- Cases with `assertions.json`: 4 of 4.
- Capabilities with native repo evidence anchoring at least one assertion:
  LossTerm composition (BinderTargetContact, WithinBinderContact, TargetBinderPAE,
  BinderTargetPAE, IPTMLoss, PLDDTLoss), simplex_APGM optimizer, the step-size
  heuristic, Boltz2 `build_multisample_loss` and ipTM/ipSAE terms, all four
  troubleshooting rows, and the decision-tree routing (bindcraft / boltzgen /
  rfdiffusion+proteinmpnn).
- Capabilities covered only by synthetic assertions: none — every assertion maps
  to real `SKILL.md` text.
- Capabilities lacking assertions: none material (mosaic is a small root-only skill).
- Cases with fixtures: none — no local input files are needed; all guidance is
  code-level and grounded in the skill text.
