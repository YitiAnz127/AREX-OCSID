/**
 * P1-02: a recorded score must stay reproducible after the temporary workspace
 * is deleted. These tests capture evidence from a real workspace, delete it, and
 * prove the verdict replays — and that every way the archive could be
 * incomplete or tampered with is reported instead of silently passing.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	WORKSPACE_EVIDENCE_FILE,
	assertSafeOutputRelativePath,
	captureWorkspaceEvidence,
	readWorkspaceEvidence,
	replayWorkspaceVerifier,
	workspaceEvidencePath,
	writeWorkspaceEvidence,
} from "./workspace-evidence.ts";
import { parseWorkspaceVerifier, verifyWorkspace } from "./workspace-verifier.ts";

const VERIFIER_TEXT = JSON.stringify({
	schema: "ocsid.workspace-verifier.v1",
	checks: [
		{ type: "file-exists", path: "output/notes.txt" },
		{ type: "json-number-range", path: "output/result.json", key: "count", min: 2, max: 4 },
	],
}, null, 2);

function tmpRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A workspace whose output/ satisfies VERIFIER_TEXT, plus a run dir to archive into. */
function makeRun(): { workspace: string; runDir: string; cleanup: () => void } {
	const root = tmpRoot("ocsid-p102-");
	const workspace = path.join(root, "workspace");
	const runDir = path.join(root, "quality", "run-1");
	fs.mkdirSync(path.join(workspace, "output"), { recursive: true });
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(workspace, "output", "result.json"), JSON.stringify({ count: 3 }), "utf8");
	fs.writeFileSync(path.join(workspace, "output", "notes.txt"), "two plus one\n", "utf8");
	return { workspace, runDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function capture(run: { workspace: string; runDir: string }): void {
	const verifier = parseWorkspaceVerifier(VERIFIER_TEXT);
	const verdict = verifyWorkspace(run.workspace, verifier);
	writeWorkspaceEvidence(run.runDir, captureWorkspaceEvidence({
		workspaceRoot: run.workspace,
		runId: "run-1",
		skillId: "gget",
		caseId: "root/case-a",
		verifier,
		verdict,
	}));
}

describe("archived workspace evidence (P1-02)", () => {
	it("replays the identical verdict after the graded workspace is deleted", () => {
		const run = makeRun();
		try {
			capture(run);
			const liveVerdict = verifyWorkspace(run.workspace, parseWorkspaceVerifier(VERIFIER_TEXT));
			// The premise of P1-02: the workspace the score was computed in is gone.
			fs.rmSync(run.workspace, { recursive: true, force: true });
			expect(fs.existsSync(run.workspace)).toBe(false);

			const replay = replayWorkspaceVerifier(run.runDir);
			expect(replay.consistent).toBe(true);
			expect(replay.mismatches).toEqual([]);
			expect(replay.replayed).toEqual(liveVerdict);
			expect(replay.recorded).toEqual(liveVerdict);
			expect(replay.fileCount).toBe(2);
			expect(replay.uncoveredPaths).toEqual([]);
			expect(replay.verifierSha256).toBe(parseWorkspaceVerifier(VERIFIER_TEXT).sha256);
		} finally {
			run.cleanup();
		}
	});

	it("restores file bytes exactly, including nested dirs and no trailing newline", () => {
		const run = makeRun();
		try {
			const nested = path.join(run.workspace, "output", "figures");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(nested, "plot.csv"), "x,y\n1,2", "utf8");
			capture(run);
			const evidence = readWorkspaceEvidence(run.runDir);
			const plot = evidence.files.find((f) => f.path === "output/figures/plot.csv");
			expect(plot?.content).toBe("x,y\n1,2");
			expect(plot?.bytes).toBe(7);
		} finally {
			run.cleanup();
		}
	});

	it("reports archive drift when a stored file's own digest does not match its content", () => {
		const run = makeRun();
		try {
			capture(run);
			const file = workspaceEvidencePath(run.runDir);
			const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
			evidence.files[0].sha256 = "0".repeat(64);
			fs.writeFileSync(file, JSON.stringify(evidence, null, 2), "utf8");
			const replay = replayWorkspaceVerifier(run.runDir);
			expect(replay.consistent).toBe(false);
			expect(replay.mismatches.join("\n")).toMatch(/hashes to .*claims/);
		} finally {
			run.cleanup();
		}
	});

	it("reports a verdict that no longer reproduces instead of passing it", () => {
		const run = makeRun();
		try {
			capture(run);
			const file = workspaceEvidencePath(run.runDir);
			const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
			evidence.verdict.perAssertion[0].outcome = "fail";
			evidence.verdict.perAssertion[0].score = 0;
			fs.writeFileSync(file, JSON.stringify(evidence, null, 2), "utf8");
			const replay = replayWorkspaceVerifier(run.runDir);
			expect(replay.consistent).toBe(false);
			expect(replay.mismatches).toContain("replayed verdict differs from the recorded verdict");
		} finally {
			run.cleanup();
		}
	});

	it("refuses to replay when the archived verifier bytes were changed", () => {
		const run = makeRun();
		try {
			capture(run);
			const file = workspaceEvidencePath(run.runDir);
			const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
			evidence.verifier.text = evidence.verifier.text.replace('"max": 4', '"max": 400');
			fs.writeFileSync(file, JSON.stringify(evidence, null, 2), "utf8");
			expect(() => replayWorkspaceVerifier(run.runDir)).toThrow(/binding is broken/);
		} finally {
			run.cleanup();
		}
	});

	it("flags a checked path the archive could not restore (oversized output)", () => {
		const run = makeRun();
		try {
			const verifier = parseWorkspaceVerifier(VERIFIER_TEXT);
			const verdict = verifyWorkspace(run.workspace, verifier);
			const evidence = captureWorkspaceEvidence({
				workspaceRoot: run.workspace,
				runId: "run-1",
				skillId: "gget",
				caseId: "root/case-a",
				verifier,
				verdict,
				maxBytes: 1,
			});
			expect(evidence.files).toEqual([]);
			expect(evidence.omitted.every((o) => o.reason === "oversized")).toBe(true);
			writeWorkspaceEvidence(run.runDir, evidence);
			const replay = replayWorkspaceVerifier(run.runDir);
			expect(replay.consistent).toBe(false);
			expect(replay.uncoveredPaths).toEqual(["output/notes.txt", "output/result.json"]);
			expect(replay.mismatches.join("\n")).toMatch(/does not restore checked path/);
		} finally {
			run.cleanup();
		}
	});

	it("records non-UTF-8 and symlinked outputs as omissions rather than lossy text", () => {
		const run = makeRun();
		try {
			fs.writeFileSync(path.join(run.workspace, "output", "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
			try {
				fs.symlinkSync(path.join(run.workspace, "output", "notes.txt"), path.join(run.workspace, "output", "link.txt"), "file");
			} catch {
				/* symlink creation may be unavailable; the bin case still covers omissions */
			}
			capture(run);
			const evidence = readWorkspaceEvidence(run.runDir);
			expect(evidence.omitted.find((o) => o.path === "output/blob.bin")?.reason).toBe("not-utf8");
			expect(evidence.files.map((f) => f.path)).not.toContain("output/blob.bin");
			expect(evidence.files.map((f) => f.path)).toContain("output/notes.txt");
			if (evidence.omitted.some((o) => o.path === "output/link.txt")) {
				expect(evidence.omitted.find((o) => o.path === "output/link.txt")?.reason).toBe("symlink");
			}
		} finally {
			run.cleanup();
		}
	});

	it("treats a run without archived evidence as a clear error, not an empty pass", () => {
		const run = makeRun();
		try {
			expect(() => readWorkspaceEvidence(run.runDir)).toThrow(new RegExp(WORKSPACE_EVIDENCE_FILE));
			expect(() => replayWorkspaceVerifier(run.runDir)).toThrow(/P1-02|predates/);
		} finally {
			run.cleanup();
		}
	});

	it("rejects archive paths that escape output/", () => {
		expect(() => assertSafeOutputRelativePath("output/ok.txt")).not.toThrow();
		expect(() => assertSafeOutputRelativePath("../etc/passwd")).toThrow(/escapes/);
		expect(() => assertSafeOutputRelativePath("output/../../etc/passwd")).toThrow(/escapes/);
		expect(() => assertSafeOutputRelativePath("/etc/passwd")).toThrow(/relative POSIX/);
		expect(() => assertSafeOutputRelativePath("output\\win.txt")).toThrow(/relative POSIX/);
		expect(() => assertSafeOutputRelativePath("notes.txt")).toThrow(/below output/);
		const run = makeRun();
		try {
			capture(run);
			const file = workspaceEvidencePath(run.runDir);
			const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
			evidence.files[0].path = "output/../../escape.json";
			fs.writeFileSync(file, JSON.stringify(evidence, null, 2), "utf8");
			expect(() => replayWorkspaceVerifier(run.runDir)).toThrow(/escapes/);
		} finally {
			run.cleanup();
		}
	});

	it("captures an empty output tree as evidence with no files", () => {
		const run = makeRun();
		try {
			fs.rmSync(path.join(run.workspace, "output"), { recursive: true, force: true });
			const verifier = parseWorkspaceVerifier(VERIFIER_TEXT);
			const verdict = verifyWorkspace(run.workspace, verifier);
			writeWorkspaceEvidence(run.runDir, captureWorkspaceEvidence({
				workspaceRoot: run.workspace, runId: "run-1", skillId: "gget", caseId: "root/case-a", verifier, verdict,
			}));
			const replay = replayWorkspaceVerifier(run.runDir);
			expect(replay.fileCount).toBe(0);
			expect(replay.replayed).toEqual(verdict);
			expect(replay.consistent).toBe(false); // both checks fail, and no file was restored for them
			expect(replay.uncoveredPaths).toEqual(["output/notes.txt", "output/result.json"]);
		} finally {
			run.cleanup();
		}
	});
});
