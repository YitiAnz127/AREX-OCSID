# ocsid CLI

This directory contains the local CLI derived from DisCo 0.2.1.

The npm package identity in `package.json` is `ocsid@0.2.1`, and the only
published executable is `ocsid -> dist/cli.js`. Internal compatibility names
remain DisCo: configuration uses `.disco`, environment variables use the
`DISCO_*` prefix, and many source types retain DisCo names.

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

The repository-level managed installers still download
`@arex-skill/disco`. They are not installers for this local package.

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

Despite the package rename, the code currently retains:

- `.disco/` for project configuration;
- the configured DisCo agent directory for user settings, credentials, sessions,
  extensions, and installed skills;
- `DISCO_*` environment variables;
- `metadata.disco-role` in skill frontmatter.

The package does not read the repository-root `auth.json` or `settings.json`
as source documentation. Those files are local runtime artifacts.

## Repository skills

The CLI bundles an empty repository-skills router template with the same
2-area/10-family taxonomy as the domain collection. The npm package does not
contain the 109 live repository skills under the repository root.

The inherited `repo-skills install` and `repo-skills update` commands still
use the upstream AREX-Skill Git repository by default. They therefore do not
deploy the current working-tree chemistry subset.

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
npx vitest --run --config vitest.config.ts src/core/repo-skills-library-manager.test.ts src/disco/import_repo_skill.test.ts src/disco/build_repo_skills_collection.test.ts
```

The complete inherited suite includes platform-specific cases. On Windows,
interpret full-suite failures separately from the focused taxonomy tests.

## Package boundary

`package.json` includes `dist`, CLI docs, examples, the shrinkwrap file,
license, changelog, and third-party notices. The package verifier runs
`npm pack --dry-run` and checks links, runtime imports, package identity, and
resource boundaries.

