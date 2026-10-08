# OCSID chemistry and biochemistry skill collection

[简体中文](README.zh-CN.md)

This repository is a domain-focused derivative of
[VectorSpaceLab/AREX-Skill](https://github.com/VectorSpaceLab/AREX-Skill). The
checked-out collection keeps repository skills relevant to chemistry,
biochemistry, molecular science, pharmaceutical research, and nearby biomedical
workflows. It also contains the OCSID CLI source: a local rename-fork of the upstream
AREX-Skill CLI (`@arex-skill/disco`), with local integration changes.

## Current scope

The live router indexes under `skills/repositories/` are the source of truth
for repository-root and membership counts:

- 109 repository-skill roots
- 127 area/family memberships
- 2 areas and 10 families
- 683 `SKILL.md` files in the repository-skill trees, including root and
  nested skills
- 651 task-oriented `SKILL.md` files: FrontierCS 9, PaperBench 636, PassNet 6

The repository-skill and task-oriented trees therefore contain 1,334
`SKILL.md` files combined. This number excludes router entries, CLI resources,
and staging material.

| Area | Family | Memberships |
| --- | --- | ---: |
| Biomedical AI | Clinical Prediction from Health Records | 2 |
| Biomedical AI | Drug Discovery and Development | 15 |
| Scientific Computing | Biomolecular Visualization | 6 |
| Scientific Computing | Genomics and Bioinformatics | 27 |
| Scientific Computing | Materials Informatics | 5 |
| Scientific Computing | Molecular Informatics | 20 |
| Scientific Computing | Molecular Simulation | 14 |
| Scientific Computing | Protein Modeling | 36 |
| Scientific Computing | Quantum Chemistry | 1 |
| Scientific Computing | Quantum Computing | 1 |

Membership counts are not unique repository counts because a repository skill
may belong to more than one family.

## Repository layout

```text
OCSID/
├── skills/
│   ├── repositories/
│   │   ├── repo-skills/          # 109 live repository-skill roots
│   │   └── repo-skills-router/   # generated live router and indexes
│   ├── task-oriented/            # FrontierCS, PaperBench, PassNet
│   └── third-party-staging/      # retained staging material
├── scripts/
│   ├── import_thirdparty.py      # optional import from an external source tree
│   ├── rebuild_router.py         # check or rebuild the live router
│   └── tests/                    # regression tests for the domain scripts
├── cli/                          # ocsid 0.2.1 (rename-fork of the upstream CLI)
├── docs/
└── examples/
```

The router's machine-readable files are:

- `references/index/taxonomy.json`
- `references/index/repositories.jsonl`
- `references/index/assignments.jsonl`
- `references/index/build-metadata.json`

The CLI bundles an empty router template with the same taxonomy. The 109 live
repository skills are not copied into the npm package.

## Validate the collection

Requires Python 3.10 or newer:

```powershell
python scripts/rebuild_router.py
python -m unittest scripts.tests.test_domain_scripts -v
Get-ChildItem skills/task-oriented -Directory | ForEach-Object { "{0}={1}" -f $_.Name, (Get-ChildItem $_.FullName -Recurse -Filter SKILL.md -File).Count }
```

The first command is read-only. It exits with status 1 when generated router
files or the root repository index are stale.

To preview third-party imports, provide the separate source-tree location:

```powershell
python scripts/import_thirdparty.py --source-root <path-to-s-skills> --dry-run
```

A real import writes new repository-skill roots. Rebuild the live router
explicitly afterward:

```powershell
python scripts/import_thirdparty.py --source-root <path-to-s-skills>
python scripts/rebuild_router.py --write-live
```

`--output-dir <directory>` generates a router elsewhere without modifying the
live repository index.

## CLI development

The local package is named `ocsid`, version 0.2.1, and requires Node.js
22.19.0 or newer.

```powershell
cd cli
npm install
npm run typecheck
npm run test:examples
npm run build
node dist/cli.js --version
```

The managed installers under `scripts/install-disco.*` target the published
upstream `@arex-skill/disco` package; they do not install this local `ocsid`
build. To link the local build, run `scripts/build-from-source-link.sh`.

## Provenance boundaries

The collection combines retained AREX repository skills with 49 roots imported
from four external source trees. In the current central index, `source_commit`
is null for all 109 records, and the 49 imported roots use logical repository
identifiers so that each skill has a unique routing identity. Their
`repo-provenance.md` files describe the local import origin, but the current
index is not a commit-pinned reproduction manifest.

## Documentation

Start with [the documentation index](docs/README.md), then use the generated
[repository catalog](docs/repository-catalog.md) for exact coverage. Upstream
OCSID workflow documents remain in the repository for CLI development, but
statements about the original 1,000-repository AREX collection do not describe
this domain subset.

## License

The repository retains the upstream project license in [LICENSE](LICENSE).
Imported skill content may have separate upstream terms; see each skill's
provenance and license fields.
