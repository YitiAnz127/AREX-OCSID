# Current-case infrastructure smoke snapshot

This manifest freezes the current `skills/tests/` case files on 2026-10-01. It preserves the `benchmark-v1` skill split (4 train, 3 dev, 3 heldout) and covers 43 cases. The original `benchmark-v1/manifest.json` remains untouched; its stored content digests no longer match the present case trees.

Use this snapshot only to test benchmark loading, real agent execution, artifact persistence, and grading plumbing. Most assertions are text-oriented, so its scores are not independent scientific task results or evidence of `Q`/`M` improvement. A research comparison still needs executable, private verifiers and separate same-skill task and cross-skill repair splits.
