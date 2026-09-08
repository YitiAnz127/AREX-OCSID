# Repository skills router maintenance

The bundled router is an empty template. Its fixed taxonomy contains 2 areas
and 10 families; repository assignments are supplied by a validated collection
or import transaction.

The live collection is generated from each repository skill's
`references/repo-routing-metadata.json` plus the central repository and
assignment records. Every assignment must match the exact taxonomy.

Use `scripts/update_repo_skills_router.mjs` and
`scripts/import_repo_skill.mjs` for transactional CLI imports. The importer
restores both the previous skill and router if a transaction fails.

Do not hand-edit router Markdown as the import mechanism. The repository root
also contains `scripts/rebuild_router.py` for checking or rebuilding the
checked-out domain collection.
