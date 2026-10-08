# ocsid CLI

This directory contains the local `ocsid` CLI: a rename-fork of the upstream `@arex-skill/disco` 0.2.1 CLI.

The npm package identity in `package.json` is `ocsid@0.2.1`, and the only
published executable is `ocsid -> dist/cli.js`. The rename is applied throughout:
configuration uses `.ocsid`, environment variables use the `OCSID_*` prefix, and
source types, assets, and docs carry the `ocsid` names.

## Requirements

- Node.js 22.19.0 or newer
- npm
- Credentials for a supported model provider when running model-backed sessions

## Build from this checkout

```powershell
npm install
npm run typecheck
npm run test:examples
npm run build
node dist/cli.js --version
```

Linking or installing this package locally exposes the `ocsid` command.

The repository-level managed installers (`scripts/install-disco.sh`,
`scripts/install-disco.ps1`) still download the published upstream
`@arex-skill/disco` package. They are not installers for this local package.

## Roles

The inherited runtime exposes two explicit roles:

- Creator: constructs, imports, extends, and verifies skills.
- Researcher: uses operating skills and dynamic workflows for tasks.

Examples after installing or linking the local package:

```powershell
ocsid --researcher
ocsid --creator
ocsid -p "Inspect this project"
ocsid --continue
ocsid --resume
ocsid --mode json -p "Summarize the current repository"
```

Use `ocsid --help` for the complete command surface.

## Configuration and data

The code uses:

- `.ocsid/` for project configuration;
- the configured OCSID agent directory for user settings, credentials, sessions,
  extensions, and installed skills;
- `OCSID_*` environment variables;
- `metadata.ocsid-role` in skill frontmatter.

Runtime state (credentials, settings, sessions, installed skills) lives in the
configured agent directory, `~/.ocsid/agent` by default. It is not stored in this
checkout and is not project documentation.

## Repository skills

The CLI bundles an empty repository-skills router template with the same
2-area/10-family taxonomy as the domain collection. The npm package does not
contain the 109 live repository skills under the repository root.

`repo-skills install` and `repo-skills update` fetch
`https://github.com/YitiAnz127/ocsid-repo-skill.git` by default. They therefore
deploy the published collection, not the current working-tree chemistry subset.

The domain collection itself is validated from the repository root:

```powershell
python scripts/rebuild_router.py
```

## Verification

```powershell
npm run typecheck
npm run test:examples
npm run verify:provenance
npm run verify:rpiv-todo-contract
npm run verify:package
```

Focused tests for the domain taxonomy integration are:

```powershell
npx vitest --run --config vitest.config.ts src/core/repo-skills-library-manager.test.ts src/ocsid/import_repo_skill.test.ts src/ocsid/build_repo_skills_collection.test.ts
```

The complete inherited suite includes platform-specific cases. On Windows,
interpret full-suite failures separately from the focused taxonomy tests.

## Package boundary

`package.json` includes `dist`, CLI docs, examples, the shrinkwrap file,
license, changelog, and third-party notices. The package verifier runs
`npm pack --dry-run` and checks links, runtime imports, package identity, and
resource boundaries.

