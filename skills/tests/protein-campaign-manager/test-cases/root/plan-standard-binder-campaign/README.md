# Plan a standard 10-binder campaign

## User Persona
A novice-to-intermediate protein designer who knows the broad goal (produce 10 binders) but not the campaign-manager skill's planning numbers, pipeline, or Modal command strings. They explicitly ask for planning metrics, cost, and runnable commands.

## Scenario Coverage
- Skill area: root (`protein-campaign-manager`)
- Capability: goal-to-pipeline campaign planning (sizing, cost, yield, commands)
- Difficulty: basic
- Prompt file: `user_request.txt`
- Expected references/scripts: `SKILL.md` (Goal-oriented design, Complete pipeline generator, Campaign size recommendations, Cost estimation)
- Trigger expectation: A request to plan a multi-binder design campaign with sizing/cost/pipeline routes directly to protein-campaign-manager.

## Expected Successful Behavior
- Reproduces the "10 binders for EGFR"-style planning block: recommended pipeline rfdiffusion -> proteinmpnn -> chai -> protein-qc, ~500 backbones, ~4,000 sequences, 8-12 h, ~$60.
- Gives the concrete rfdiffusion command (`python run_inference.py inference.input_pdb=target.pdb contigmap.contigs=[A1-150/0 70-100] ppi.hotspot_res=[A45,A67,A89] inference.num_designs=500`).
- Gives the ProteinMPNN loop over `output/*.pdb` with `modal run modal_ligandmpnn.py --input-pdb "$f" --params-str "--number_of_batches 8 --temperature 0.1"` and the `grep -c "^>"` checkpoint (~4000).
- Gives checkpoint expectations (500 backbones, after QC ~10-15% pass, 400-600 candidates, clustering to 10-20 diverse final designs).

## Failure Signals
- Provides only vague advice ("generate a lot of backbones") without the concrete commands or numbers from SKILL.md.
- Omits the expected shell command strings or the yield table.
- Recommends a pipeline/number that contradicts the documented 50x rule and the 10-binder row (500 backbones / 4,000 seqs).
- Tells the user to open files from the original protein-design-skills/campaign-manager checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
