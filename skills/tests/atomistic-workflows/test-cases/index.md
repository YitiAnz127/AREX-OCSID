# atomistic-workflows — Usability Test Cases

Index of usability test cases for the generated `atomistic-workflows` repo skill.

`atomistic-workflows` is a **routed tree skill** under the `ase` root: the `ase`
top-level router branches to `ase-ase-workflows` (workflow intent → static /
relax / md / neb leaves) and `ase-ase-calculators` (backend intent → gpaw /
mace adapters). The leaf workflow sub-skills are `ase-ase-workflows-static`,
`-relax`, `-md`, `-neb`; the backend adapters are `ase-ase-calculators-gpaw`
and `ase-ase-calculators-mace`. This skill contains **no bundled scripts**; all
evidence is in the sub-skill `SKILL.md` files and the two
`references/commands-and-workflow.md` routing documents.

## Case list

| Case | Area | User role | Scenario | Capability | Difficulty | Test emphasis |
|---|---|---|---|---|---|---|
| `sub-skills/ase-ase-workflows-static/silicon-single-point-gpaw` | ase-ase-workflows-static | novice-to-intermediate | Single-point energy/forces of Si with GPAW | static ASE workflow + GPAW adapter | basic | route discovery + workflow depth |
| `sub-skills/ase-ase-workflows-relax/adsorbate-slab-relax-mace` | ase-ase-workflows-relax | intermediate | Relax adsorbate/slab to fmax 0.02 with BFGS, MACE; non-convergence recovery | geometry-opt relax workflow + MACE adapter + recovery | intermediate | workflow depth + troubleshooting recovery |
| `sub-skills/ase-ase-workflows-neb/adatom-diffusion-climbing-neb` | ase-ase-workflows-neb | advanced | Climbing-image NEB with 7 images, spring policy, barrier extraction, MACE | NEB / transition-state workflow | advanced | workflow depth + barrier output policy |
| `sub-skills/ase-ase-workflows-md/bulk-water-npt-equilibration` | ase-ase-workflows-md | intermediate | NPT 300 K / 1 atm water MD equilibration with MACE, checkpoint/restart | MD workflow + ensemble/barostat + trajectory policy | intermediate | workflow depth + support workflow |
| `sub-skills/ase-ase-calculators/backend-selection-gpaw-vs-mace` | ase-ase-calculators | novice-to-intermediate | Choose between GPAW and MACE backends, compare prerequisites | backend selection/config adapter routing | intermediate | support-workflow discoverability + router clarification |

## Coverage note vs surface

All four workflow leaves (static, relax, md, neb) have a dedicated case, and the
backend adapters router has a selection case covering both GPAW and MACE
configuration. The `ase` top-level router and the `ase-ase-workflows` /
`ase-ase-calculators` middle router behavior is exercised implicitly by the
routing expectations in each case. The `mace` adapter has its own configured use
across multiple cases; the `gpaw` adapter is covered by the static case and the
backend-selection case. No dedicated case targets the `ase` top-level router's
mixed-request rule directly, but this is low-risk because every case includes a
routing expectation that forces the correct tree path. No material coverage gap.

## Difficult-case coverage

- **Per-sub-skill difficult synthetic cases:**
  - `ase-ase-workflows-relax/adsorbate-slab-relax-mace` (intermediate with
    recovery) extends the relax leaf evidence with a non-convergence/BFGS→FIRE
    recovery path beyond the original `SKILL.md` scope.
  - `ase-ase-workflows-neb/adatom-diffusion-climbing-neb` (advanced) extends the
    NEB leaf evidence with explicit image count, climbing-image, spring and
    barrier-output requirements.
  - `ase-ase-workflows-md/bulk-water-npt-equilibration` (intermediate) extends
    the MD leaf evidence with NPT barostat/thermostat, initial-velocity and
    checkpoint/restart decisions.
  - All are synthesized from the sub-skill `SKILL.md` files; the skill ships no
    bundled scripts or repo-native tests, so there are no script-anchored cases.
- **Integrated difficult cases:** none created explicitly. The tree is
  router-based; each case already crosses the workflow router and the backend
  adapter, so a separate whole-skill integration case would be redundant.
- **Original repo-native cases:** none — no captures repo-native tests tree
  exists; every case is synthesized from the bundled routing documents and
  sub-skill specs.

## Assertion coverage

- Cases with `assertions.json`: 5 of 5.
- Capabilities with native repo evidence anchoring at least one assertion:
  static single-point script + GPAW mode/XC/k-points; relax optimizer + fmax +
  MACE checkpoint/device; NEB image setup + climbing image + barrier output;
  MD timestep/ensemble/barostat/trajectory/restart; backend selection comparison
  (GPAW vs MACE adapter prerequisites) and router clarification.
- Capabilities covered only by synthetic assertions: the same set — assertions
  are anchored to the sub-skill `SKILL.md` / routing `references/*.md` evidence.
- Capabilities lacking assertions: none material; the `ase` top-level router's
  mixed-request and "ask one focused question" rules are asserted indirectly in
  the calculators case.
- Cases with fixtures: none (no local input files needed; scenarios are
  structure-description prompts, not file-driven).
