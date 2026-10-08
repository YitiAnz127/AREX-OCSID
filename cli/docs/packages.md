> ocsid can help you create ocsid packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# OCSID Packages

OCSID packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `ocsid` key, or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a OCSID Package](#creating-a-ocsid-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** OCSID packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
ocsid install npm:@foo/bar@1.0.0
ocsid install git:github.com/user/repo@v1
ocsid install https://github.com/user/repo  # raw URLs work too
ocsid install /absolute/path/to/package
ocsid install ./relative/path/to/package

ocsid remove npm:@foo/bar
ocsid list                     # show installed packages from settings
ocsid update                   # update ocsid only
ocsid update --all             # update ocsid, update packages, and reconcile pinned git refs
ocsid update --extensions      # update packages and reconcile pinned git refs only
ocsid update --models          # refresh model catalogs only
ocsid update --self            # update ocsid only
ocsid update --self --force    # reinstall ocsid even if current
ocsid update npm:@foo/bar      # update one package
ocsid update --extension npm:@foo/bar
```

These commands manage ocsid packages and `ocsid update` can update the ocsid CLI installation. To uninstall ocsid itself, see [Quickstart](quickstart.md#uninstall).

By default, `install` and `remove` write to user settings (`~/.ocsid/agent/settings.json`). Use `-l` to write to project settings (`.ocsid/settings.json`) instead. Project settings can be shared with your team, and ocsid installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
ocsid -e npm:@foo/bar
ocsid -e git:github.com/user/repo
```

## Package Sources

OCSID accepts three source types in settings and `ocsid install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`ocsid update --extensions`, `ocsid update --all`).
- User installs go under `~/.ocsid/agent/npm/`.
- Project installs go under `.ocsid/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `ocsid update --extensions` and `ocsid update --all` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `ocsid install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.ocsid/agent/git/<host>/<path>` (global) or `.ocsid/git/<host>/<path>` (project).
- When reconciliation changes the checkout, ocsid resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
ocsid install git:git@github.com:user/repo

# ssh:// protocol format
ocsid install ssh://git@github.com/user/repo

# With version ref
ocsid install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, ocsid loads resources using package rules.

## Creating a OCSID Package

Add a `ocsid` manifest to `package.json` or use conventional directories. Include the `ocsid-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["ocsid-package"],
  "ocsid": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Discovery Metadata

Add the `ocsid-package` keyword so users can find compatible packages in npm search. Optional `video` and `image` fields may be used by package indexes or documentation tools:

```json
{
  "name": "my-package",
  "keywords": ["ocsid-package"],
  "ocsid": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: URL for a demonstration video.
- **image**: URL for a representative image.

OCSID itself does not currently host or query a package gallery.

## Package Structure

### Convention Directories

If no `ocsid` manifest is present, ocsid auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When ocsid installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

OCSID bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `ocsid`, `@earendil-works/pi-tui`, `typebox`.

Other ocsid packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. OCSID loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "ocsid": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Mode Targeting <a id="mode-targeting"></a>

Use `ocsid install <source> --for ...` to set the default visibility of all
resources from one package:

| Target | Visible roles |
|--------|---------------|
| `creator` | Creator sessions |
| `researcher` | Researcher sessions |
| `both` | Creator and Researcher sessions |
| `default` | Package default behavior |

This changes package resource visibility without copying or splitting the
package. Individual resource filters can further narrow the selected package.

## Enable and Disable Resources

Use `ocsid config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. `ocsid config` starts in global settings (`~/.ocsid/agent/settings.json`); press Tab to switch between global and project-local modes. Use `ocsid config -l` to start in project overrides (`.ocsid/settings.json`) with inherited global resources dimmed.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins unless the project entry has `autoload: false`, in which case it is applied as a delta over the global entry. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
