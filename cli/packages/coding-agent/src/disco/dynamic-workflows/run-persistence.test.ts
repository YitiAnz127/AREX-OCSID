import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRunPersistence, type PersistedRunState } from "./run-persistence.ts";
import { workflowProjectPaths } from "./workflow-paths.ts";

function makeState(runId: string): PersistedRunState {
	return { runId, status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

describe("run persistence", () => {
	it("BUG (.bak rotation): .bak holds the PREVIOUS committed state, not a duplicate of the new one", () => {
		const cwd = mkdtempSync(join(tmpdir(), "arex-rp-"));
		const runs = workflowProjectPaths(cwd).runsDir;
		try {
			const p = createRunPersistence(cwd);
			p.save(makeState("r1"));
			// .bak is absent until a second save rotates the first in.
			expect(existsSync(join(runs, "r1.json.bak"))).toBe(false);

			// Make the second state distinguishable by CONTENT. Differentiating the two
			// saves by updatedAt alone was timing-flaky: it is stamped with
			// toISOString() at millisecond resolution, so two saves in the same
			// millisecond produced identical stamps and the ordering assertion failed
			// on a fast machine.
			p.save({ ...makeState("r1"), status: "paused" });

			// .bak now holds the PREVIOUS committed state; the primary holds the new one.
			const bak = JSON.parse(readFileSync(join(runs, "r1.json.bak"), "utf8")) as PersistedRunState;
			const primary = JSON.parse(readFileSync(join(runs, "r1.json"), "utf8")) as PersistedRunState;
			expect(bak.status).toBe("running");
			expect(primary.status).toBe("paused");
			expect(primary.updatedAt >= bak.updatedAt).toBe(true);
			// load() falls back from a corrupt primary to .bak
			writeFileSync(join(runs, "r1.json"), "{ not json", "utf8");
			expect(p.load("r1")?.status).toBe("running");
		} finally {
			rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
		}
	});

	it("BUG (stale lock TTL): a lock whose pid appears alive but is older than the TTL is reclaimed", () => {
		const cwd = mkdtempSync(join(tmpdir(), "arex-rp2-"));
		const runs = workflowProjectPaths(cwd).runsDir;
		try {
			mkdirSync(runs, { recursive: true });
			const p = createRunPersistence(cwd);
			// Simulate a wedged lock: pid = our own process (alive), startedAt long past.
			writeFileSync(
				join(runs, "r2.lock"),
				JSON.stringify({
					runId: "r2",
					runPath: join(runs, "r2.json"),
					pid: process.pid,
					startedAt: "2000-01-01T00:00:00Z",
					token: "stale-token",
				}),
				"utf8",
			);
			const lease = p.acquireRunLease("r2");
			expect(lease).not.toBeNull();
			expect(lease?.runId).toBe("r2");
			p.releaseRunLease(lease!);
		} finally {
			rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
		}
	});

	it("P0-02 (audit F1): a path-traversal runId is rejected and cannot read/delete outside runsDir", () => {
		const cwd = mkdtempSync(join(tmpdir(), "arex-rp3-"));
		const paths = workflowProjectPaths(cwd);
		const runs = paths.runsDir;
		try {
			mkdirSync(runs, { recursive: true });
			// Plant a victim file OUTSIDE runsDir that a traversal runId must never touch.
			const victim = join(cwd, "victim.json");
			writeFileSync(victim, '{"secret":true}', "utf8");

			const p = createRunPersistence(cwd);
			// Each persistence boundary must reject the traversal before touching the fs.
			expect(() => p.save(makeState("../victim"))).toThrow();
			expect(() => p.load("../../victim")).toThrow();
			expect(() => p.delete("..\\victim")).toThrow();
			expect(() => p.acquireRunLease("../../victim")).toThrow();

			// The victim file is untouched and still readable after all those attempts.
			expect(JSON.parse(readFileSync(victim, "utf8"))).toEqual({ secret: true });
			// No stray files were written into runsDir by the rejected attempts.
			expect(existsSync(join(runs, "victim.json"))).toBe(false);
			expect(existsSync(join(runs, "victim.lock"))).toBe(false);
		} finally {
			rmSync(paths.rootDir, { recursive: true, force: true });
		}
	});

	it("P0-02 (audit F1): list() drops entries whose FILE-CONTENT runId is unsafe", () => {
		const cwd = mkdtempSync(join(tmpdir(), "arex-rp5-"));
		const paths = workflowProjectPaths(cwd);
		const runs = paths.runsDir;
		try {
			mkdirSync(runs, { recursive: true });
			// list() takes runId from the parsed file CONTENT, not the filename, so a
			// crafted/edited run file can carry an unsafe id. It must never reach
			// callers that feed listed ids back into load/acquireRunLease
			// (recoverStaleRuns), where an unsafe id throws.
			writeFileSync(join(runs, "crafted.json"), JSON.stringify(makeState("../../escape")), "utf8");
			writeFileSync(join(runs, "good.json"), JSON.stringify(makeState("good1")), "utf8");

			const listed = createRunPersistence(cwd).list();
			expect(listed.map((r) => r.runId)).toEqual(["good1"]);
		} finally {
			rmSync(paths.rootDir, { recursive: true, force: true });
		}
	});

	it("P0-02 (audit F1): a safe internal-style runId still works", () => {
		const cwd = mkdtempSync(join(tmpdir(), "arex-rp4-"));
		const paths = workflowProjectPaths(cwd);
		try {
			const p = createRunPersistence(cwd);
			const runId = "m3xyz12-ab34cd-ef56gh";
			p.save(makeState(runId));
			expect(p.load(runId)?.runId).toBe(runId);
			expect(p.acquireRunLease(runId)).not.toBeNull();
			expect(p.delete(runId)).toBe(true);
		} finally {
			rmSync(paths.rootDir, { recursive: true, force: true });
		}
	});
});
