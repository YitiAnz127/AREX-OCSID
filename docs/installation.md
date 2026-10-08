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

The root `scripts/install-disco.ps1` and `scripts/install-disco.sh` are retained
upstream installers. They install the published upstream `@arex-skill/disco`
package, not this local `ocsid` build.

## Use the collection

The populated collection lives at `skills/repositories/`. The npm package
contains only an empty router template with the same taxonomy; it does not
contain the 109 repository skills.

Load or copy the collection with the mechanism supported by the target agent.
Do not assume that `ocsid repo-skills install` installs this working-tree
subset: its default managed source is `https://github.com/YitiAnz127/ocsid-repo-skill.git`.

For a manual deployment, copy the complete `skills/repositories/` directory as
one unit into the target agent's configured skill root, preserving the sibling
`repo-skills/` and `repo-skills-router/` layout. Use an empty destination or
back up an existing collection before replacing it.

## Name the deployed collection (deployment acceptance)

Because the npm package ships an empty router and `ocsid repo-skills install`
pulls a remote collection, "the skills are installed" is ambiguous. A complete
deployment record must state which collection is live and capture its identity:

```powershell
node dist/cli.js repo-skills status          # managed vs local collection identity
python scripts/rebuild_router.py             # working-tree index consistency
```

Record every field the status output prints — Source, Commit, Official skills
(managed by `ocsid`), Local skills, Total repo skills, Routed repositories,
Area-family assignments, Router taxonomy, Files, Router, Drift. `Official skills:
0` with `Local skills: 109` means the deployment runs the working-tree
collection and no npm-managed one was installed; a deployment that does rely on
`repo-skills install` must record the source repository and the 40-hex commit
that landed, not just the skill count. Example from this checkout:

```text
Installed: yes
Managed by ocsid: no
Official skills: 0
Local skills: 109
Total repo skills: 109
Routed repositories: 109
Area-family assignments: 127
Router taxonomy: 2 areas, 10 families
Files: 2503
Router: enabled
Drift: none
```

Commit pinning is partial: 38 of the 109 records carry a recorded
`source_commit` and 71 do not (see `docs/imported-repo-skills.md`), so the
working-tree collection is an identity-and-routing inventory, not a fully
commit-pinned manifest. State that limitation in the deployment record too.

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

Machine-local runtime state (credentials, settings, sessions, installed skills)
lives in the OCSID agent directory, `~/.ocsid/agent` by default. It is not stored
in this checkout and should not be treated as project documentation.
`cli/node_modules/` is dependency data.
