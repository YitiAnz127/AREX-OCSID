# Rank Boltz-2 designs with a multi-sample ipTM/ipSAE loss

## User Persona
An advanced protein-design user who has already run a Boltz-2 design optimization
and needs the expert-tuned Nipah-competition ranking workflow. They require
API-faithful guidance (model methods and arguments), not a generic scoring tip.

## Scenario Coverage
- Skill area: root (`mosaic`)
- Capability: Boltz2 `build_multisample_loss` ranking with ipTM/ipSAE terms
- Difficulty: advanced
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (Worked example: ranking with ipSAE)
- Trigger expectation: The prompt is explicitly the SkILL.md worked example —
  ranking Boltz-2 designs with the ipSAE multi-sample loss from the Adaptyv
  Nipah recipe.

## Expected Successful Behavior
- Routes to `mosaic` and gives the Boltz2 ranking loss exactly as in SKILL.md:
  `from mosaic.models.boltz2 import Boltz2`, instantiate `Boltz2()`, then
  `boltz2.build_multisample_loss(loss=1.00*IPTMLoss() + 0.5*TargetBinderIPSAE() + 0.5*BinderTargetIPSAE(), features=..., num_samples=6, recycling_steps=3)`.
- Emphasizes the multi-sample loss is a method on the Boltz2 model, not a free
  function.
- Carries over the two practices: let the optimizer choose the epitope, and match
  filter stringency to assay throughput.
- Keeps the reproducibility caveat that this is a small expert-tuned sample, not
  a guarantee across targets.

## Failure Signals
- Treats the ranking loss as a free function instead of a `Boltz2` method.
- Uses invented argument names for the multisample loss.
- Suggests a turnkey default (e.g. bindcraft) instead of Mosaic's custom-objective
  ranking.
- Points at the original escalante-bio/mosaic checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
