# multimolecule-command-preflight

## User persona
An experienced computational scientist who knows the AlphaFold3 task well but is
not familiar with this package's CLI surface)Skip. They want to run a
protein+RNA multimolecule inference without hand-editing a long command.

## Scenario coverage
Routes to the `cli-serving` sub-skill. The user asks to (a) build a safe,
non-interactive CLI command for two entity kinds, (b) confirm it can be built
without launching inference, (c) learn the output format (mmCIF), and (d)
understand the `--precision` limitation rather than be misled into thinking it
enables real mixed precision on the GPU.

## Expected successful behavior
The response routes to cli-serving, uses the bundled `build_cli_command.py`
helper to produce/verify a shell-quoted command without running it, repeats
`--protein` / `--rna` once per entity, treats `--use-cuda` as an explicit Click
boolean, states the CLI writes mmCIF, and refuses to claim `--precision` changes
model device/dtype (the current executable does not).

## Failure signals
- Claims the helper runs inference or downloads weights.
- Builds the command by hand instead of using `build_cli_command.py`.
- States the output is PDB for the CLI (that is the app's per-session format).
- Claims `--precision` enables mixed precision / quantization / CUDA.

## Why this triggers the generated skill
The task names AlphaFold3 CLI operation and entity repetition, which is exactly
the `cli-serving` operating path.
