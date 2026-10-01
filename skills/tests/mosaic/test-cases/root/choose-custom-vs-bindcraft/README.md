# Route between Mosaic and bindcraft

## User Persona
An intermediate protein designer choosing a framework. They explicitly frame the
decision between Mosaic and bindcraft and between running a custom multi-objective
loss vs a turnkey pipeline, and want the decision tree plus exit routes.

## Scenario Coverage
- Skill area: root (`mosaic`)
- Capability: decision-tree routing (custom objective vs one-click, and exit routes)
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (When Mosaic fits, Decision tree)
- Trigger expectation: The prompt names binder design and the Mosaic-vs-bindcraft
  choice, and tests whether the skill surfaces its own decision tree rather than
  blindly applying Mosaic. It is a borderline/route-discovery case that should
  still trigger `mosaic` because it asks about Mosaic's fit conditions.

## Expected Successful Behavior
- Routes to `mosaic` and states Mosaic fits a custom objective across multiple
  models in one differentiable loss, and "may require substantial hand-holding
  (tuning learning rates, etc)".
- Correctly routes the user to `bindcraft` for one-click binders with default
  filters.
- Gives the decision tree: custom objective -> Mosaic; one-click binders with
  defaults -> bindcraft; all-atom diffusion -> boltzgen; backbone-only diversity ->
  rfdiffusion + proteinmpnn.
- Notes exit routes/validation (`boltz`/`chai`, `ipsae`, `protein-qc`).

## Failure Signals
- Encourages Mosaic for a user who explicitly wants a one-click default-filter
  pipeline.
- Ignores the custom-objective condition and treats Mosaic as a universal default.
- Omits the decision tree / routes to the wrong tool for a given goal.
- Points to the original escalante-bio/mosaic checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
