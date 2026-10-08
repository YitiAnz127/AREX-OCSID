# Refreshing repository skills

This page describes the tools that exist in this checkout.

## Check current consistency

```powershell
python scripts/rebuild_router.py
```

The default mode does not write files. It compares the generated router,
indexes, and root repository index with the live files. It also reports how much
provenance it could preserve:

```text
provenance: 109 repository record(s), 38 pinned to a source commit, 71 unpinned
(source_commit null), 109 carried over from skills/repositories/repo-skills/repository-index.jsonl, 38 with a repo-provenance.md block
confidence: 0 assignment(s) from routing entries, 127 preserved from
skills/repositories/repo-skills-router/references/index/assignments.jsonl, 0 defaulted in legacy mode
```

`source_commit` is only ever a full 40-hex commit, and `source_url` only ever a
GitHub repository URL; a recorded value that does not meet those contracts is
reported and dropped rather than copied.

## Confidence and routing decisions

Confidence is classification evidence, not a generated default. The verified
importer/updater contract keeps it in the central assignment index and in the
external routing decision artifact, never in per-skill runtime metadata. The
rebuild script follows the same precedence:

```powershell
python scripts/rebuild_router.py --routing-entry <handoff.json> --confidence-mode strict
```

- `--routing-entry <file>` (repeatable) supplies a verified external
  classification handoff, the same artifact the upstream
  `update_repo_skills_router.mjs` consumes:
  `{"skill_id": "...", "repo_id": "...", "assignments": [{"area": "...",
  "family": "...", "confidence": "high", "confidence_basis": "committed"}],
  "source_url": "...", "source_commit": "<40-hex>", "source_skill_root": "...",
  "legacy_repo_id": "..."}`. Its `repo_id` and its exact `(area, family)` set are
  validated against `references/repo-routing-metadata.json`; a duplicate
  `skill_id`, an unknown skill, or a mismatched assignment set is an error.
- `--confidence-mode strict` requires every assignment to have a recorded
  confidence: either a routing entry or an explicit metadata value. A prior
  index row is deliberately **not** accepted as evidence in strict mode, because
  the value in that row may itself be a legacy default. Use
  `--confidence-mode legacy` (the default) to keep the historical
  default-to-`high` behavior, which prints an explicit warning.
- `--source-index <file>` and `--source-assignments <file>` select the prior
  records used to preserve identity, provenance, aliases, and recorded
  confidence. Both default to the live files.

`--flag=value` and `--flag value` are equivalent, and an unknown or valueless
option is an error rather than a silently ignored argument.

## Inspect generated output

```powershell
python scripts/rebuild_router.py --output-dir <directory>
```

This writes only beneath the selected output directory. It does not modify
`skills/repositories/repo-skills/repository-index.jsonl`.

## Rebuild the live router

```powershell
python scripts/rebuild_router.py --write-live
```

This updates the live router and synchronizes the root repository index.
The taxonomy itself is read from the live router; changing taxonomy requires
updating every per-skill taxonomy hash and the CLI's bundled empty template.

## Import the configured third-party set

The importer requires a separate source tree:

```powershell
python scripts/import_thirdparty.py --source-root <source-root> --dry-run
python scripts/import_thirdparty.py --source-root <source-root>
python scripts/rebuild_router.py --write-live
```

The full plan expects `SciAgent-Skills`,
`computational-chemistry-agent-skills`, `DrugClaw`, and
`protein-design-skills`. Partial source trees are accepted: missing clusters
are reported and skipped. Existing target roots are also skipped.
For newly imported roots and flattened sub-skills, the importer preserves
supported companion directories: `agents`, `assets`, `models`, `references`,
and `scripts`.

When taxonomy content changes, preserve UTF-8 with LF and a final newline, then
compute SHA-256 over the exact file bytes:

```powershell
Get-FileHash -Algorithm SHA256 skills/repositories/repo-skills-router/references/index/taxonomy.json
```

Propagate that hash to every root `references/repo-routing-metadata.json`, to
`cli/packages/coding-agent/src/core/repo-skills-library-manager.ts`, and to:

- `cli/packages/coding-agent/src/ocsid/skills/verify-repo-skill/scripts/update_repo_skills_router.mjs`
- `cli/packages/coding-agent/src/ocsid/skills/verify-repo-skill/scripts/import_repo_skill.mjs`
- `cli/packages/coding-agent/src/ocsid/skills/verify-repo-skill/scripts/build_repo_skills_collection.mjs`

Copy the exact taxonomy bytes into the CLI's bundled empty router template.
Run `update_repo_skills_router.test.ts` for generation, the import/build tests
for validators, `repo-skills-library-manager.test.ts` for managed collections,
and `export_repo_skills_to_agent.test.ts` for export compatibility. Then rebuild
the live router and CLI. There is currently no single migration command for
this multi-file operation.

## Verify after a change

```powershell
python scripts/rebuild_router.py
python -m unittest scripts.tests.test_domain_scripts -v

cd cli
npm run typecheck
npm run test:examples
npm run verify:provenance
npm run verify:rpiv-todo-contract
npm run verify:package
```

If the CLI taxonomy or bundled skills change, run the focused Vitest files for
the repository manager, importer, and collection builder.

## Provenance limitation

The rebuild script preserves provenance that is already recorded; it never
invents it. Repository records are built with the upstream precedence
(routing entry > existing index row > `references/repo-provenance.md` >
derived value), so a commit that was recorded during import reaches
`repository-index.jsonl` on the next rebuild instead of being reset to null.

What is still missing is evidence that was never captured:

- 71 of the 109 records are `source_commit: null`. Their provenance blocks
  record `"commit": null` (or carry no block at all), and the rebuild reports
  them as unpinned. Do not describe a refresh as commit-pinned unless that
  counter reaches zero.
- `source_skill_root` is null for every record: no existing
  `repo-provenance.md` block carries `generated_skill.root`. New imports written
  by `import_thirdparty.py` do include it.
- `import_thirdparty.py` records the source commit only when the imported source
  directory is inside a git work tree; otherwise it records null rather than a
  guess.
