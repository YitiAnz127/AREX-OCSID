# Local setup and validation

This checkout contains a live skill collection and an optional local CLI build.
They are validated separately.

## Requirements

- Python 3.10 or newer for domain import and router tools
- Node.js 22.19.0 or newer for the CLI
- npm for installing and building CLI dependencies

## Validate the live skill collection

From the repository root:

```powershell
python scripts/rebuild_router.py
python -m unittest scripts.tests.test_domain_scripts -v
```

`rebuild_router.py` is read-only by default.

## Build the local CLI

```powershell
cd cli
npm install
npm run typecheck
npm run test:examples
npm run build
node dist/cli.js --version
```

The local package is `ocsid@0.2.1`; its executable is `ocsid` when linked or
installed as a package.

The root `scripts/install-disco.ps1` and `scripts/install-disco.sh` are
retained upstream installers. They install `@arex-skill/disco`, not this local
`ocsid` package.

## Use the collection

The populated collection lives at `skills/repositories/`. The npm package
contains only an empty router template with the same taxonomy; it does not
contain the 109 repository skills.

Load or copy the collection with the mechanism supported by the target agent.
Do not assume that `ocsid repo-skills install` installs this working-tree
subset: its default managed source remains the upstream AREX-Skill repository.

For a manual deployment, copy the complete `skills/repositories/` directory as
one unit into the target agent's configured skill root, preserving the sibling
`repo-skills/` and `repo-skills-router/` layout. Use an empty destination or
back up an existing collection before replacing it.

## Optional third-party import

The complete planned import expects the four directories named in
`scripts/import_thirdparty.py`. A partial source tree is accepted; unavailable
clusters are reported and skipped.

```powershell
python scripts/import_thirdparty.py --source-root <source-root> --dry-run
python scripts/import_thirdparty.py --source-root <source-root>
python scripts/rebuild_router.py --write-live
```

Use the dry run before a real import. Existing target skills are skipped.

## Local runtime files

Root-level `auth.json`, `settings.json`, `sessions/`, `npm/`, and
`cli/node_modules/` are machine-local runtime or dependency data. They are not
required to understand the collection and should not be treated as project
documentation.
