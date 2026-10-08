# Using OCSID

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model. Totals include assistant responses, usage reported by tools, and summary generation.

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Copy response | Ctrl+X copies the last assistant message; in `/tree`, it copies the selected message |
| Images | Paste with Ctrl+V, Alt+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |

See [Keybindings](keybindings.md) for all shortcuts and customization.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| [`/llama`](llama-cpp.md) | Download, load, and unload llama.cpp router models |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| [`/workflows`](dynamic-workflows.md#run-controls) | Inspect and control active, persisted, and recovery workflow runs |
| `/workflows-models` | View and edit the small, medium, and big model tiers used by workflows |
| `/deep-research <question>` | Research a question across the web with cross-checked sources |
| `/adversarial-review <task or question>` | Investigate a task and challenge findings with independent reviewers |
| `/effort off|high|ultra` | Set standing workflow effort for substantive requests |
| `/ultracode [off]` | Enable or disable standing maximal workflow effort |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and continue from there |
| `/trust` | Save project trust decision for future sessions |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL |
| `/import <file>` | Import and resume a session from a JSONL file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit ocsid |

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want ocsid to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

Background workflow execution has its own completion path: the workflow tool
returns a run ID and ends the current turn, then delivers the result back as a
follow-up when the run finishes. If another turn is active, the result waits
rather than interrupting it. See [Dynamic workflows](dynamic-workflows.md) for
run controls and recovery behavior.

## Sessions

Sessions are saved automatically to `~/.ocsid/agent/sessions/`, organized by working directory.

```bash
ocsid -c                  # Continue most recent session
ocsid -r                  # Browse and select a session
ocsid --no-session        # Ephemeral mode; do not save
ocsid --name "my task"    # Set session display name at startup
ocsid --session <path|id> # Use a specific session file or session ID
ocsid --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Context Files

OCSID loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.ocsid/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.ocsid/SYSTEM.md` for a project
- `~/.ocsid/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

### Project Trust

On interactive startup, ocsid asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.ocsid/agent/trust.json`. Trusting a project allows ocsid to load `.ocsid/settings.json` and `.ocsid` resources, install missing project packages, and execute project extensions.

Before the trust decision, ocsid loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.ocsid/agent/settings.json`, or change it with `/settings`.

`ocsid config` and package commands use the same project trust flow, except `ocsid update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.ocsid/agent/trust.json` only; the current session is not reloaded, so restart ocsid for changes to take effect.


## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link.

For upstream reference, Pi provides [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) for publishing Pi sessions to Hugging Face datasets. It targets Pi session data and is not a supported OCSID session integration.

## CLI Reference

```bash
ocsid [options] [@files...] [messages...]
```

### Package Commands

```bash
ocsid install <source> [-l]     # Install package, -l for project-local
ocsid remove <source> [-l]      # Remove package
ocsid uninstall <source> [-l]   # Alias for remove
ocsid update [source|self|ocsid]   # Update ocsid only, or one package source
ocsid update --all              # Update ocsid and packages; reconcile pinned git refs
ocsid update --extensions       # Update packages only; reconcile pinned git refs
ocsid update --models           # Refresh model catalogs only
ocsid update --self             # Update ocsid only
ocsid update --extension <src>  # Update one package
ocsid list                      # List installed packages
ocsid config                    # Enable/disable package resources
```

These commands manage ocsid packages and `ocsid update` can update the ocsid CLI installation. To uninstall ocsid itself, see [Quickstart](quickstart.md#uninstall). `ocsid config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `ocsid update` never prompts for project trust.

See [OCSID Packages](packages.md) for package sources and security notes.

### Agent Modes

| Flag | Description |
|------|-------------|
| `--creator` | Start a new session with Creator resources and workflow boundaries |
| `--researcher` | Start a new session with Researcher resources and workflow boundaries |
| `--agent-mode <mode>` | Compatibility form for `creator` or `researcher` |

These selectors choose the Agent role and work with both interactive startup and
non-interactive output. They are independent of `-p` / `--print` and
`--mode text|json|rpc`.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export a session to HTML |

In print mode, ocsid also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | ocsid -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--ocsid-no-builtin-skills` | Disable only bundled OCSID skills; keep other discovered and explicit skills |
| `--no-skills`, `-ns` | Disable all discovered skills; explicit `--skill` paths still load |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
ocsid --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include them in the message:

```bash
ocsid @prompt.md "Answer this"
ocsid -p @screenshot.png "What's in this image?"
ocsid @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
ocsid "List all .ts files in src/"

# Non-interactive
ocsid -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | ocsid -p "Summarize this text"

# Named one-shot session
ocsid --name "release audit" -p "Audit this repository"

# Different model
ocsid --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
ocsid --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
ocsid --model sonnet:high "Solve this complex problem"

# Limit model cycling
ocsid --models "claude-*,gpt-4o"

# Read-only mode
ocsid --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
ocsid --exclude-tools ask_question
```

## Design Principles

OCSID keeps the core small and pushes most task-specific behavior into
extensions, skills, prompt templates, and packages.

It intentionally does not include built-in MCP, permission popups, plan mode,
to-dos, or background bash. The minimal coding-tool set also does not expose a
general manual subagent command; coordinated subagents are managed by the
built-in [dynamic workflow runtime](dynamic-workflows.md). Other workflows can
be built or installed as extensions or packages, or run through external tools
such as containers and tmux.

For the full rationale, read the [blog post](https://mariozechner.at/posts/2025-11-30-ocsid-coding-agent/).
