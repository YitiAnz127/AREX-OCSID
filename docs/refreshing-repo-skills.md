# Refreshing repository skills

This page describes the tools that exist in this checkout.

## Check current consistency

```powershell
python scripts/rebuild_router.py
```

The default mode does not write files. It compares the generated router,
indexes, and root repository index with the live files.

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

- `cli/packages/coding-agent/src/disco/skills/verify-repo-skill/scripts/update_repo_skills_router.mjs`
- `cli/packages/coding-agent/src/disco/skills/verify-repo-skill/scripts/import_repo_skill.mjs`
- `cli/packages/coding-agent/src/disco/skills/verify-repo-skill/scripts/build_repo_skills_collection.mjs`

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

The current Python rebuild script creates central identity rows from routing
metadata. It does not recover an upstream commit, and the current 109 records
therefore have null `source_commit` values. Do not describe a refresh as
commit-pinned unless those records are populated from verified source evidence.
