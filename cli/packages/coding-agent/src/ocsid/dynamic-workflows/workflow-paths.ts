/**
 * Filesystem layout for OCSID dynamic workflow state.
 *
 * Workflow state lives under the OCSID workflow home. Project-scoped state is
 * isolated by a stable cwd-derived namespace.
 */

import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { getAgentDir } from "../../config.ts";

/**
 * Default workflow home, relative to the user's home directory.
 *
 * This is only the default layout (with no override, workflowHomeDir() resolves
 * to `homedir()/.ocsid/workflows`): the real anchor is the agent directory, so
 * that OCSID_CODING_AGENT_DIR relocates workflow state along with the rest of
 * the OCSID home.
 */
export const WORKFLOW_HOME_RELATIVE_DIR = ".ocsid/workflows";
export const WORKFLOW_PROJECTS_SUBDIR = "projects";

export interface WorkflowProjectPaths {
	key: string;
	rootDir: string;
	runsDir: string;
	savedDir: string;
	settingsPath: string;
}

/**
 * Workflow state home: the `workflows/` sibling of the agent directory.
 *
 * Derived from getAgentDir() instead of a hardcoded homedir() so that an
 * isolated or relocated OCSID home (OCSID_CODING_AGENT_DIR — the mechanism the
 * native harness, tests and anyone running two OCSID homes side by side use)
 * carries workflow runs, saved workflows and settings with it. Hardcoding
 * homedir() here silently wrote workflow state into the real user home even when
 * the rest of OCSID had been pointed at a temporary directory.
 *
 * With no override this is exactly `homedir()/.ocsid/workflows`, so existing
 * installations keep the same paths.
 */
export function workflowHomeDir(): string {
	return join(dirname(getAgentDir()), "workflows");
}

export function workflowUserSavedDir(): string {
	return join(workflowHomeDir(), "saved");
}

export function workflowProjectKey(cwd: string): string {
	const projectPath = resolve(cwd);
	const slug = sanitizePathSegment(basename(projectPath) || "project");
	const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
	return `${slug}-${hash}`;
}

export function workflowProjectPaths(cwd: string): WorkflowProjectPaths {
	const key = workflowProjectKey(cwd);
	const rootDir = join(workflowHomeDir(), WORKFLOW_PROJECTS_SUBDIR, key);
	return {
		key,
		rootDir,
		runsDir: join(rootDir, "runs"),
		savedDir: join(rootDir, "saved"),
		settingsPath: join(rootDir, "settings.json"),
	};
}

function sanitizePathSegment(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return sanitized || "project";
}
