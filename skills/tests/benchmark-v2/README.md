# Pilot Benchmark v2 (P1-01 content re-freeze)

A frozen evaluation surface for the Agent-RSI loop over OCSID's repository
skills. This directory pins *which* skills are measured, *how* the
train/dev/held-out split is drawn, and *which revision of the case files* the
measurement refers to. It does **not** claim any result.

`benchmark-v2` is the corpus the RSI loop measures today. `benchmark-v1` is
kept beside it as the archive of the original (unrecoverable) revision — see
`../benchmark-v1/README.md`.

## Contents

| File | Role |
|---|---|
| `manifest.json` | Frozen `ocsid.benchmark.v1` manifest: `name: pilot-v2`, 10 pilot skills split into train(4)/dev(3)/heldout(3), with split membership and case-tree content digests. Unchanged `splitHash` — this was a content re-freeze, not a re-split. |
| `content-index.jsonl` | The per-file evidence behind `contentHash`: one `[split, skillId, relativePath, sha256]` line per case-tree file (147 files). Lets `benchmark diff` name exactly which file drifted instead of only which split. |
| `refreeze-log.jsonl` | Append-only audit log. Every freeze/refreeze appends one record with a mandatory human `reason`, the previous revision's digests, and the sha256 of the previous `manifest.json` — so a corpus swap can never silently rewrite an earlier identity. |
| `../<skillId>/test-cases/` | Per-skill `ocsid.usability-case.v1` case trees (43 cases across the 10 skills). |

## Why v2 exists

`benchmark-v1` froze `2026-01-01T00:00:00Z`. Afterwards the case files under
`skills/tests/` were edited, and `skills/tests/` was never tracked by git, so the
original revision cannot be restored. Every `benchmark-v1` digest therefore
mismatches the present case tree, which blocked `auditPreflight` (and with it
baseline/candidate comparison and final evaluation).

The resolution is to freeze the current revision under a **new version identity** and to leave the
old manifest untouched, rather than overwrite v1's digests and silently change
what earlier v1 experiments measured. The supersession is recorded inside
`refreeze-log.jsonl` (`previous.root = benchmark-v1`,
`previous.contentHash = 15202b56…`, `previous.manifestSha256 = 8d240e50…`).

## Frozen values

| Field | Value |
|---|---|
| `name` | `pilot-v2` |
| `frozenAt` | `2026-10-03T09:16:27.958Z` |
| `splitHash` | `fabcb729156e295afed6b395f1905939f18857158351c0945c0c93525a7c7a05` (= v1) |
| `contentHash` | `f680ac8b32236cd160000f8f6b5b9832599d31a99437795f4a1c19ad0c5852a1` |
| `contentHashes.train` | `e539026bd869f8ddee42b3cb0d85669950e1f9adb8da788f3bc89f4456410cdf` |
| `contentHashes.dev` | `4bb578400761867f8b449085ea2d0a9b8221a57e622e2e1d812810133e26ce1f` |
| `contentHashes.heldout` | `1b4ae1ee4f2e00e62e233e73d2aba0e913bde11a2c3ba9a8bf2408cfd2d8f029` |

These match the independently frozen
[`../benchmark-smoke-20261001`](../benchmark-smoke-20261001/README.md) snapshot
of the same case trees, which confirms the digest algorithm and the case
revision agree.

## Freeze protocol

Never hand-edit `manifest.json`, `content-index.jsonl`, or `refreeze-log.jsonl`.
Use the tool:

```sh
ocsid repo-skills benchmark verify --root skills/tests/benchmark-v2      # read-only; drift ⇒ exit 1
ocsid repo-skills benchmark diff   --root skills/tests/benchmark-v2      # list added/removed/changed case files
ocsid repo-skills benchmark freeze --root skills/tests/benchmark-v2 \
  --reason "<why this revision supersedes the last one>" [--dry-run] [--json]
```

`freeze` refuses to run without a `reason`, refuses to change the split scope
(only the same skill split can be re-frozen), and refuses to seed a brand-new
directory without `--from <previous-version-dir>` — a new version must name the
identity it replaces so the old digests survive in the log.

Adding or editing a case file invalidates `contentHash`: re-run `verify` to see
the drift, then `freeze --reason …` to record the new revision. Changing the
*split* (which skill is train vs held-out) is a different, louder act: it is
guarded by `src/benchmark/pilot.test.ts` and `src/benchmark/benchmark-versions.test.ts`.

## Honesty contract

- Nothing here is a conclusion about routing quality. The manifest only pins
  *measurement scope and case revision*.
- Test cases and their `assertions.json` are **evaluation artifacts with real
  evidence, never synthetic guesses**, validated by
  `scripts/tests/validate_benchmark_cases.py` (schema fields + real-path check).
- `benchmark-v1` stays on disk, mismatched and unmodified, as tamper evidence.
  Re-freezing it in place would destroy the ability to tell which revision an
  old run measured.
