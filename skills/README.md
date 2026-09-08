# Skill collection

This directory contains the domain collection used by this checkout.

## Contents

- `repositories/repo-skills/`: 109 repository-skill roots.
- `repositories/repo-skills-router/`: the populated live router.
- `task-oriented/`: FrontierCS, PaperBench, and PassNet task graphs.
- `third-party-staging/`: retained staging material; it is not part of the
  109-record router index.

The repository-skill trees contain 683 `SKILL.md` files in total. This includes
the 109 root skills and their nested sub-skills.

The task-oriented trees contain another 651 `SKILL.md` files: FrontierCS 9,
PaperBench 636, and PassNet 6. The two groups total 1,334 files, excluding
router entries, CLI resources, and staging material.

There is no `mcp/` directory in the current tree.

## Router contract

The authoritative files are under
`repositories/repo-skills-router/references/index/`:

| File | Purpose |
| --- | --- |
| `taxonomy.json` | Fixed 2-area, 10-family taxonomy |
| `repositories.jsonl` | One routing identity per root skill |
| `assignments.jsonl` | 127 exact area/family memberships |
| `build-metadata.json` | Counts and file digests |

`repositories/repo-skills/repository-index.jsonl` must be byte-identical to
the router repository index. Every classified root must contain
`references/repo-routing-metadata.json` with the current taxonomy hash.

Validate these invariants with:

```powershell
python scripts/rebuild_router.py
```

## Progressive disclosure

Start at `repositories/repo-skills-router/SKILL.md`, choose one area and one
family, then open only the repository skill that matches the task. A root skill
may point to nested `sub-skills/`, `references/`, or `scripts/`.

Do not load all 109 roots into one prompt.

## Updating the live collection

Third-party import requires a separately available source tree:

```powershell
python scripts/import_thirdparty.py --source-root <source-root> --dry-run
python scripts/import_thirdparty.py --source-root <source-root>
python scripts/rebuild_router.py --write-live
```

Use `--output-dir` on the rebuild command when inspecting generated output
without changing the live router.

## Provenance limitation

The current central repository index does not pin source commits: all 109
`source_commit` fields are null. Forty-nine imported roots use logical
repository identities and declare an unknown license. Ten retained roots use
`NOASSERTION`, which is not a confirmed redistribution license. Treat
`repo-provenance.md` as descriptive and verify upstream source and license
before redistributing either group.

## CLI boundary

The CLI's bundled router under `cli/packages/coding-agent/src/disco/skills/`
is deliberately empty and contains only this taxonomy. The live collection in
this directory is not part of the `ocsid` npm package.
