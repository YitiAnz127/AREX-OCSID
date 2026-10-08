import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION, type SessionHeader, SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

describe("SessionManager OCSID mode persistence", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	function createRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "ocsid-session-mode-"));
		cleanupPaths.push(root);
		return root;
	}

	it("defaults new and legacy sessions to Researcher", () => {
		const root = createRoot();
		const fresh = SessionManager.inMemory(root);
		expect(fresh.getOcsidMode()).toBe("researcher");
		expect(fresh.getHeader()?.ocsidMode).toBe("researcher");

		const legacyPath = join(root, "legacy.jsonl");
		const legacyHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "legacy-session",
			timestamp: new Date().toISOString(),
			cwd: root,
		};
		writeFileSync(legacyPath, `${JSON.stringify(legacyHeader)}\n`, "utf8");

		const legacy = SessionManager.open(legacyPath);
		expect(legacy.getOcsidMode()).toBe("researcher");
		expect(legacy.getHeader()?.ocsidMode).toBeUndefined();
	});

	it("falls back safely when a persisted header contains an invalid mode", () => {
		const root = createRoot();
		const sessionPath = join(root, "invalid-mode.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "invalid-mode-session",
				timestamp: new Date().toISOString(),
				cwd: root,
				ocsidMode: "Creator",
			})}\n`,
			"utf8",
		);

		expect(SessionManager.open(sessionPath).getOcsidMode()).toBe("researcher");
	});

	it("round-trips Creator through a persisted branch and open", () => {
		const root = createRoot();
		const sessionDir = join(root, "sessions");
		const session = SessionManager.create(root, sessionDir, { ocsidMode: "creator" });
		session.appendMessage(userMsg("creator request"));
		const assistantId = session.appendMessage(assistantMsg("creator response"));

		const branchedPath = session.createBranchedSession(assistantId);
		expect(branchedPath).toBeTruthy();
		expect(session.getOcsidMode()).toBe("creator");
		expect(SessionManager.open(branchedPath!).getOcsidMode()).toBe("creator");

		const persistedHeader = JSON.parse(readFileSync(branchedPath!, "utf8").split("\n")[0]) as SessionHeader;
		expect(persistedHeader.ocsidMode).toBe("creator");
	});

	it("uses the requested mode when opening a new explicit session path", () => {
		const root = createRoot();
		const sessionPath = join(root, "explicit-creator.jsonl");
		const session = SessionManager.open(sessionPath, undefined, undefined, { ocsidMode: "creator" });

		expect(session.getOcsidMode()).toBe("creator");
		expect(session.getHeader()?.ocsidMode).toBe("creator");
		expect(session.getSessionFile()).toBe(sessionPath);
	});

	it("keeps the current mode for a new session unless explicitly overridden", () => {
		const root = createRoot();
		const session = SessionManager.inMemory(root, { ocsidMode: "creator" });

		session.newSession();
		expect(session.getOcsidMode()).toBe("creator");
		expect(session.getHeader()?.ocsidMode).toBe("creator");

		session.newSession({ ocsidMode: "researcher" });
		expect(session.getOcsidMode()).toBe("researcher");
	});

	it("persists pre-assistant context explicitly so a mode switch can resume it", () => {
		const root = createRoot();
		const session = SessionManager.create(root, join(root, "sessions"), { ocsidMode: "creator" });
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeTruthy();
		session.appendMessage(userMsg("context interrupted before the assistant response"));
		expect(existsSync(sessionFile!)).toBe(false);

		expect(session.persistForResume()).toBe(true);
		expect(existsSync(sessionFile!)).toBe(true);
		expect(session.persistForResume()).toBe(true);

		const resumed = SessionManager.open(sessionFile!);
		expect(resumed.getOcsidMode()).toBe("creator");
		expect(resumed.getEntries()).toHaveLength(1);
	});

	it("inherits mode when forking across projects and permits an explicit override", () => {
		const root = createRoot();
		const sourceDir = join(root, "source-sessions");
		const source = SessionManager.create(join(root, "source"), sourceDir, { ocsidMode: "creator" });
		source.appendMessage(userMsg("source request"));
		source.appendMessage(assistantMsg("source response"));
		const sourcePath = source.getSessionFile();
		expect(sourcePath).toBeTruthy();

		const inherited = SessionManager.forkFrom(
			sourcePath!,
			join(root, "target-inherited"),
			join(root, "target-inherited-sessions"),
		);
		const overridden = SessionManager.forkFrom(
			sourcePath!,
			join(root, "target-overridden"),
			join(root, "target-overridden-sessions"),
			{ ocsidMode: "researcher" },
		);

		expect(inherited.getOcsidMode()).toBe("creator");
		expect(overridden.getOcsidMode()).toBe("researcher");
	});
});
