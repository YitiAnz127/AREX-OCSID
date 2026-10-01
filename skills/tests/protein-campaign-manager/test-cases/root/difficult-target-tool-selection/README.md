# Select a tool and variant for a difficult target

## User Persona
An experienced designer who has already run a campaign that came back POOR (4% pass) and can name interface-failure symptoms, Flex targets, and wants concrete alternative commands. Advanced: they must combine the target-difficulty assessment, the tool-selection guide, and the pipeline-variant commands, and reason about why the interface metric fails.

## Scenario Coverage
- Skill area: root (`protein-campaign-manager`)
- Capability: target-difficulty assessment + tool selection + pipeline variant comparison
- Difficulty: advanced
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (Tool selection guide, Target difficulty assessment, Pipeline variants, Campaign health assessment)
- Trigger expectation: A difficult-target binder campaign with a POOR pass rate and interface failure routes to protein-campaign-manager for both diagnosis and tool/variant selection.

## Expected Successful Behavior
- Uses the target-difficulty table: a flexible, flat/convex, low-conservation target with no known binders is a DIFFICULT target (expected pass rate 5-10%).
- Connects the 4% overall pass and failing interface predictions to the documented "Low ipTM - hotspot or interface issue" and to the fact that this is a difficult/flexible target.
- Recommends a tool appropriate for a difficult or all-atom-precision target from the tool-selection guide. Options in the evidence: Mosaic for "difficult target" (gradient, multi-model objective), BoltzGen for all-atom/side-chain awareness, or BindCraft for a harder target needing an integrated design loop — the response must defend the choice from that table rather than invent a tool.
- Gives the high-throughput variant: `python run_inference.py inference.num_designs=2000` and `modal run modal_ligandmpnn.py --input-pdb bb.pdb --params-str "--number_of_batches 4 --temperature 0.2"`, and the high-quality variant: `inference.num_designs=200` with `--number_of_batches 32 --temperature 0.1`, and explains the tradeoff (diversity vs per-design quality, temperature).

## Failure Signals
- Recommends a tool that is not in the documented tool-selection table, or recommends one for the wrong reason.
- Ignores the interface/ipTM failure mode and only restates throughput numbers.
- Confuses the high-throughput and high-quality variant parameters (e.g. 2000 backbones with temperature 0.1, or 200 backbones with temperature 0.2).
- Does not use the target-difficulty indicators to justify treating the target as difficult.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
