# Quickstart

This page gets you from install to a useful first ocsid session.

## Install

`ocsid` is not published to npm. Build and link it from this checkout:

```bash
cd cli
npm install
npm run build
npm link
ocsid --version
```

For the full local flow (validation commands, the live skill collection, and the
retained upstream installers), see the repository's Installation Guide at
`docs/installation.md` (it ships with the repository checkout, not with the
published npm package).

### Uninstall

Remove the global link created by `npm link`:

```bash
npm unlink -g ocsid     # or: npm rm -g ocsid
```

Uninstalling ocsid leaves settings, credentials, sessions, and installed ocsid packages in `~/.ocsid/agent/`.

Then start ocsid in the project directory you want it to work on:

```bash
cd /path/to/project
ocsid
```

## Authenticate

OCSID can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start ocsid and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching ocsid:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
ocsid
```

You can also run `/login` and select an API-key provider to store the key in `~/.ocsid/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once ocsid starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, ocsid gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. OCSID runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give ocsid project instructions

OCSID loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

OCSID loads:

- `~/.ocsid/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart ocsid, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
ocsid @README.md "Summarize this"
ocsid @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
ocsid -c                  # Continue most recent session
ocsid -r                  # Browse previous sessions
ocsid --name "my task"    # Set session display name at startup
ocsid --session <path|id> # Open a specific session
```

Inside ocsid, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
ocsid -p "Summarize this codebase"
cat README.md | ocsid -p "Summarize this text"
ocsid -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using OCSID](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [OCSID Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
