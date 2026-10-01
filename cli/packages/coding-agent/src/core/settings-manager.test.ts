import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "./settings-manager.ts";

function makeDirs(): { root: string; agentDir: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "settings-mgr-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	return { root, agentDir, cwd };
}

describe("SettingsManager atomic settings write (B1)", () => {
	it("save writes settings.json and leaves no .tmp orphan", async () => {
		const dirs = makeDirs();
		try {
			const manager = SettingsManager.create(dirs.cwd, dirs.agentDir);
			manager.setHttpIdleTimeoutMs(12345);
			// persistScopedSettings runs on the write queue, so the file is not on
			// disk when the setter returns — flush() is what makes this deterministic.
			await manager.flush();
			const settingsPath = join(dirs.agentDir, "settings.json");
			expect(existsSync(settingsPath)).toBe(true);
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(parsed.httpIdleTimeoutMs).toBe(12345);
			// Atomic temp+rename: no .tmp sibling should remain.
			expect(existsSync(`${settingsPath}.tmp`)).toBe(false);
		} finally {
			rmSync(dirs.root, { recursive: true, force: true });
		}
	});

	it("creates settings.json owner-only with no group/other access", async () => {
		const dirs = makeDirs();
		try {
			const manager = SettingsManager.create(dirs.cwd, dirs.agentDir);
			manager.setHttpIdleTimeoutMs(12345);
			await manager.flush();
			const settingsPath = join(dirs.agentDir, "settings.json");
			// settings.json can hold an httpProxy URL with embedded credentials, and
			// it shares a directory with auth.json — it must not be world-readable.
			// Windows is ACL-based and does not apply POSIX mode bits.
			if (process.platform !== "win32") {
				expect(statSync(settingsPath).mode & 0o077).toBe(0);
			}
			expect(existsSync(settingsPath)).toBe(true);
		} finally {
			rmSync(dirs.root, { recursive: true, force: true });
		}
	});
});

describe("SettingsManager parseTimeoutSetting non-throw (H1)", () => {
	it("malformed httpIdleTimeoutMs degrades to default instead of throwing", () => {
		const manager = SettingsManager.inMemory({ httpIdleTimeoutMs: "abc" } as never);
		expect(() => manager.getHttpIdleTimeoutMs()).not.toThrow();
		expect(manager.getHttpIdleTimeoutMs()).toBe(300_000);
	});

	it("websocketConnectTimeoutMs malformed value does not throw", () => {
		const manager = SettingsManager.inMemory({ websocketConnectTimeoutMs: "nonsense" } as never);
		expect(() => manager.getWebSocketConnectTimeoutMs()).not.toThrow();
		expect(manager.getWebSocketConnectTimeoutMs()).toBeUndefined();
	});
});

describe("SettingsManager deepMergeSettings nested survival (H3)", () => {
	it("override adds a nested sibling without dropping base nested fields", () => {
		const manager = SettingsManager.inMemory({
			retry: { provider: { timeoutMs: 1000 } },
		} as never);
		manager.applyOverrides({ retry: { provider: { maxRetryDelayMs: 60000 } } } as never);
		const result = manager.getProviderRetrySettings();
		expect(result.timeoutMs).toBe(1000); // base sibling survived
		expect(result.maxRetryDelayMs).toBe(60000); // override field present
	});
});
