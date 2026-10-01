import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowSettings, saveWorkflowSettings } from "./workflow-settings.ts";

describe("saveWorkflowSettings atomic write (B1b)", () => {
	it("writes settings.json and leaves no .tmp orphan", () => {
		const dir = mkdtempSync(join(tmpdir(), "wf-settings-"));
		const path = join(dir, "settings.json");
		try {
			saveWorkflowSettings({ defaultConcurrency: 4 }, path);
			expect(existsSync(path)).toBe(true);
			const parsed = JSON.parse(readFileSync(path, "utf-8"));
			expect(parsed.defaultConcurrency).toBe(4);
			// Atomic temp+rename: no .tmp sibling should remain.
			expect(existsSync(`${path}.tmp`)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("round-trips loaded settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "wf-settings-"));
		const path = join(dir, "settings.json");
		try {
			saveWorkflowSettings({ defaultConcurrency: 8, progressPanelMode: "detailed" }, path);
			expect(loadWorkflowSettings(path)).toMatchObject({
				defaultConcurrency: 8,
				progressPanelMode: "detailed",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
