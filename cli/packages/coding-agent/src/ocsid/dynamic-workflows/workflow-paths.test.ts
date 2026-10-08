import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_AGENT_DIR } from "../../config.ts";
import { getModelTierConfigPath } from "./model-tier-config.ts";
import { workflowHomeDir, workflowProjectKey, workflowProjectPaths, workflowUserSavedDir } from "./workflow-paths.ts";

// P2-03: workflow persistence used to hardcode homedir()/.ocsid/workflows, so an
// isolated or relocated OCSID home (OCSID_CODING_AGENT_DIR) still wrote runs,
// saved workflows and settings into the real user home.
const previousAgentDir = process.env[ENV_AGENT_DIR];
const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
});

function useAgentDir(...segments: string[]): { root: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "arex-wp-"));
	tempRoots.push(root);
	const agentDir = join(root, ...segments);
	process.env[ENV_AGENT_DIR] = agentDir;
	return { root, agentDir };
}

describe("workflow paths follow the OCSID home", () => {
	it("keeps the historical homedir()/.ocsid/workflows layout when nothing is overridden", () => {
		delete process.env[ENV_AGENT_DIR];
		expect(workflowHomeDir()).toBe(join(homedir(), ".ocsid", "workflows"));
		expect(workflowUserSavedDir()).toBe(join(homedir(), ".ocsid", "workflows", "saved"));
	});

	it("relocates the workflow home to the sibling of an overridden agent directory", () => {
		const { root, agentDir } = useAgentDir("custom", "agent");
		const home = join(root, "custom", "workflows");

		expect(agentDir).toBe(join(root, "custom", "agent"));
		expect(workflowHomeDir()).toBe(home);
		expect(workflowUserSavedDir()).toBe(join(home, "saved"));
		// The real user home is no longer the workflow home.
		expect(workflowHomeDir().startsWith(root)).toBe(true);
		expect(getModelTierConfigPath()).toBe(join(home, "model-tiers.json"));
	});

	it("places every project path under the relocated workflow home", () => {
		const { root } = useAgentDir("custom", "agent");
		const home = join(root, "custom", "workflows");
		const cwd = join(root, "workspace", "demo-project");
		const paths = workflowProjectPaths(cwd);

		expect(paths.key).toBe(workflowProjectKey(cwd));
		expect(paths.rootDir).toBe(join(home, "projects", paths.key));
		expect(paths.runsDir).toBe(join(paths.rootDir, "runs"));
		expect(paths.savedDir).toBe(join(paths.rootDir, "saved"));
		expect(paths.settingsPath).toBe(join(paths.rootDir, "settings.json"));
	});

	it("derives a stable project key that does not depend on the workflow home", () => {
		const cwd = join("C:", "work", "Demo Project!");
		const key = workflowProjectKey(cwd);
		const { root } = useAgentDir("custom", "agent");

		expect(key).toBe(workflowProjectKey(cwd));
		expect(workflowProjectPaths(cwd).key).toBe(key);
		// The key is a cwd-derived namespace, not a home-relative path.
		expect(key).not.toContain(root);
	});
});
