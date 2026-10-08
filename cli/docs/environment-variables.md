# Environment Variables

OCSID has its own `OCSID_*` namespace. Pi-owned variables such as
`PI_CODING_AGENT_DIR`, `PI_PACKAGE_DIR`, `PI_CACHE_RETENTION`, and
`PI_OAUTH_CALLBACK_HOST` do not configure OCSID. The CLI and RPC entry points
remove known Pi process variables before loading the runtime; the headless SDK
also filters `PI_*` values from provider auth and uses OCSID-owned paths and
OAuth flows.

Provider credentials such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are not
Pi-specific and remain available. They are documented in
[Providers](providers.md#environment-variables-or-auth-file).

## Process marker

The CLI and RPC entry points set `OCSID_CODING_AGENT=true`. Child processes
inherit it and can detect that they run inside OCSID. It is not session-specific
and is not set automatically when OCSID is embedded through the SDK.

## Bash tool session environment

Commands run by the LLM-callable bash tool receive the current OCSID session
state:

| Variable | Description |
| --- | --- |
| `OCSID_SESSION_ID` | Current session ID |
| `OCSID_SESSION_FILE` | Absolute session JSONL path; unset for ephemeral sessions |
| `OCSID_PROVIDER` | Selected model provider |
| `OCSID_MODEL` | Selected model ID |
| `OCSID_REASONING_LEVEL` | Effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching model or reasoning
level therefore affects the next bash command without restarting OCSID.

```bash
printf '%s/%s\n' "$OCSID_PROVIDER" "$OCSID_MODEL"
printf 'reasoning=%s session=%s\n' "$OCSID_REASONING_LEVEL" "$OCSID_SESSION_ID"
```

These variables are injected into the LLM-callable bash tool, not user-entered
`!` or `!!` commands.

### Custom bash tools

Bash tools created with `createBashTool()` expose the session environment by
default. Injection happens before `spawnHook`, so the hook receives the values
in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable it independently of the hook:

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, OCSID removes inherited session values so a nested process does
not receive stale metadata from its parent session.

## User configuration

| Variable | Description |
| --- | --- |
| `OCSID_CODING_AGENT_DIR` | Override the global agent directory; default `~/.ocsid/agent` |
| `OCSID_CODING_AGENT_SESSION_DIR` | Override session storage; `--session-dir` takes precedence |
| `OCSID_OFFLINE` | Disable startup network operations, update checks, package updates, model-catalog refresh, and install telemetry |
| `OCSID_SKIP_VERSION_CHECK` | Disable only the automatic npm registry version check |
| `OCSID_CACHE_RETENTION` | Provider prompt-cache policy: `none`, `short` (default), or `long` |
| `OCSID_OAUTH_CALLBACK_HOST` | Host interface for supported local OAuth callback servers; default `127.0.0.1` |
| `OCSID_SHARE_VIEWER_URL` | Override the base viewer URL used by `/share` |
| `OCSID_NO_SPLASH` | Disable the interactive startup animation when truthy |
| `OCSID_EXPERIMENTAL` | Enable the experimental first-run setup when set to `1` |
| `OCSID_HARDWARE_CURSOR` | Show the hardware cursor when set to `1`, unless settings override it |
| `OCSID_CLEAR_ON_SHRINK` | Clear terminal rows after content shrinks when set to `1` |
| `VISUAL`, `EDITOR` | External-editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Standard proxy configuration for OCSID-managed HTTP clients |

The `httpProxy` setting can populate `HTTP_PROXY` and `HTTPS_PROXY` when those
variables are not already set. See [Settings](settings.md#network).

## Telemetry and attribution

OCSID has no built-in install-telemetry endpoint.

| Variable | Description |
| --- | --- |
| `OCSID_TELEMETRY` | Force install telemetry and provider attribution headers on or off using `1`/`true`/`yes` or `0`/`false`/`no` |
| `OCSID_INSTALL_TELEMETRY_URL` | Distributor-supplied install/update version-ping endpoint; no request is sent when unset |

`enableInstallTelemetry` in settings controls the same behavior when
`OCSID_TELEMETRY` is unset. Provider attribution consists of documented client
headers sent only to providers that support attribution; it does not send a
separate telemetry request.

## Distribution overrides

These variables are intended for package distributors, controlled deployments,
and integration tests. Normal npm users do not need them.

| Variable | Description |
| --- | --- |
| `OCSID_PACKAGE_DIR` | Override the installed package root, for example in Nix/Guix stores |
| `OCSID_LATEST_VERSION_URL` | Override the npm-compatible JSON endpoint used for version checks |
| `OCSID_CHANGELOG_URL` | Add a changelog link to update notifications |
| `OCSID_MODEL_CATALOG_URL` | Enable a remote model-catalog overlay service |

By default, version checks read a `https://registry.npmjs.org/<package-name>/latest`
endpoint derived from the package name. This build is not published to npm, so
the default endpoint does not describe it; point `OCSID_LATEST_VERSION_URL` at
your own endpoint to get meaningful update notifications. OCSID has no default
remote model-catalog or changelog service.

## Development diagnostics

| Variable | Description |
| --- | --- |
| `OCSID_TIMING` | Print internal timing measurements when set to `1` |
| `OCSID_STARTUP_BENCHMARK` | Run the interactive startup benchmark and suppress the splash |

Development-only proxy endpoints and credentials must be supplied to the test
process. They are not package defaults and must not be embedded in source,
documentation, or the npm tarball.
