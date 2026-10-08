/**
 * Configuration constants for OCSID dynamic workflows.
 */

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

/** Default timeout for a single agent in milliseconds. null means no hard timeout. */
export const DEFAULT_AGENT_TIMEOUT_MS = null;

/** Maximum concurrent agents (matches Claude Code limit). */
export const MAX_CONCURRENCY = 16;

/** Maximum automatic retry attempts after a recoverable agent failure. */
export const MAX_AGENT_RETRIES = 3;

/** Default automatic retry attempts; timeout failures get one retry by default. */
export const DEFAULT_AGENT_RETRIES = 1;

/** Default number of recovery rounds for an incomplete coverage ledger. */
export const DEFAULT_MAX_RECOVERY_ROUNDS = 50;

/** Hard ceiling for recovery rounds, even when a caller requests more. */
export const MAX_RECOVERY_ROUNDS = 1_000;

/** Default token budget if none specified. */
export const DEFAULT_TOKEN_BUDGET = null;

/**
 * User-level saved workflows directory, as the DEFAULT layout string.
 *
 * Do not resolve this against homedir(): the workflow home follows the agent
 * directory (see workflow-paths.ts::workflowUserSavedDir), so an isolated or
 * relocated OCSID home moves saved workflows with it.
 */
export const USER_WORKFLOW_SAVED_DIR = "~/.ocsid/workflows/saved";

/**
 * User-level model tiers config file, relative to the home directory.
 *
 * Only the file name is authoritative here; resolve the directory through
 * model-tier-config.ts::getModelTierConfigPath().
 */
export const MODEL_TIERS_FILE = ".ocsid/workflows/model-tiers.json";

/**
 * User-level workflow extension settings file, as the DEFAULT layout string.
 *
 * Same caveat as USER_WORKFLOW_SAVED_DIR: resolve through
 * workflow-settings.ts::getWorkflowSettingsPath() / getWorkflowProjectSettingsPath().
 */
export const WORKFLOW_SETTINGS_FILE = ".ocsid/workflows/settings.json";

/**
 * Named workflow subagent definitions directory. Resolved both project-relative
 * (cwd/.ocsid/agents) and home-relative (~/.ocsid/agents); project entries win on name
 * collision. Each `*.md` file is an agent definition (frontmatter + body prompt).
 */
export const AGENTS_DIR = ".ocsid/agents";
