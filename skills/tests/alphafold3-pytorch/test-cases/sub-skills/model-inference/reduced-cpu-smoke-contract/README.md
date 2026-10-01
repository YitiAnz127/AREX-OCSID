# reduced-cpu-smoke-contract

## User persona
A maintainer integrating the package into a larger pipeline who wants a cheap,
deterministic guarantee that the model contract is intact before spending GPU
time, with realistic expectations about what a smoke test proves.

## Scenario coverage
Routes to `model-inference`. The user wants a bounded CPU-only contract probe
using the bundled helper, correct `--mode`/`--device`/`--num-sample-steps`
flags, and proper checkpoint loading via `init_and_load`.

## Expected successful behavior
The response routes to model-inference, uses `scripts/smoke_model.py` with an
explicit CPU device and a deliberately reduced model, runs
`--mode signature` first and only a tiny forward with
`--num-sample-steps 2`, and clearly states the helper never downloads weights/
encoders, never trains, and proves contract, not structural accuracy or
throughput. For a package-saved checkpoint it recommends `init_and_load` and
verifying version/device/strictness.

## Failure signals
- Suggests production-scale defaults or CUDA as the smoke configuration.
- Claims the smoke helper proves useful structural accuracy or throughput.
- Loads a checkpoint by guessing instead of `init_and_load` with verification.
- Runs inference without validating input/index offsets.

## Why this triggers the generated skill
Naming AlphaFold3 model construction/forward on CPU is the model-inference
`Operatiting sequence` route.
