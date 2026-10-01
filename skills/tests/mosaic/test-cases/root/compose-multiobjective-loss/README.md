# Compose a multi-objective binder design loss

## User Persona
An intermediate protein designer who knows they need Mosaic's custom-objective
capability (multiple learned objectives in one differentiable loss) and
understands binders, but is not yet fluent in the Mosaic `LossTerm` API, the
optimizer choices, or the step-size heuristic.

## Scenario Coverage
- Skill area: root (`mosaic`)
- Capability: composing `mosaic.losses.structure_prediction` `LossTerm` objects and choosing an optimizer/step size
- Difficulty: basic
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (Core idea, What you can compose, Optimizers)
- Trigger expectation: The prompt asks for a custom objective across multiple
  model terms — the defining reason to reach for Mosaic per SKILL.md ("Reach for
  it when a fixed pipeline cannot express the objective you need").

## Expected Successful Behavior
- Routes to `mosaic` and builds the design loss from `LossTerm` objects using
  Python arithmetic (addition and scaling):
  `BinderTargetContact`, `WithinBinderContact`, `TargetBinderPAE`,
  `BinderTargetPAE`, `IPTMLoss`, `PLDDTLoss` with scalar weights as in SKILL.md.
- Recommends `simplex_APGM` as the default optimizer (proximal/vmirror descent).
- Suggests a step size near `0.1 * sqrt(binder_length)` (~0.77 for a 60-residue
  binder).
- Notes JIT makes the first call slow and later calls fast.

## Failure Signals
- Treats Mosaic as a one-click method or ignores objective composition.
- Uses invented loss-term names not present in SKILL.md.
- Skips the optimizer/step-size guidance, or gives a step size not tied to
  `0.1 * sqrt(binder_length)`.
- Points to the original `escalante-bio/mosaic` checkout instead of the skill.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
