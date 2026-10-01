import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { classifySkillPath } from "./classifier.ts";
import { computeUsageMetrics } from "./metrics.ts";
import { ObserverWriter, readAllEvents, writeHealthFile, type ObserverHealth } from "./storage.ts";
import { buildUsageReport } from "./report.ts";
import { RepoSkillObserver } from "./index.ts";
import type { RepoSkillEvent } from "./events.ts";

const tmpRoots: string[] = [];

function makeTmp(sub = "observer"): string {
	const dir = mkdtempSync(join(tmpdir(), `rsi-${sub}-`));
	tmpRoots.push(dir);
	return dir;
}

afterAll(() => {
	for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const ROOT = "/home/u/.disco/agent/skills/repositories";

function routerRow(over: Partial<RepoSkillEvent> = {}): RepoSkillEvent {
	return {
		schemaVersion: 1,
		eventId: "e",
		ts: "t",
		sessionId: "s1",
		turnId: "1",
		eventType: "router_read",
		...over,
	};
}

describe("classifySkillPath", () => {
	it("classifies a router index path", () => {
		const r = classifySkillPath(`${ROOT}/repo-skills-router/references/index/taxonomy.json`, ROOT);
		expect(r.matched).toBe(true);
		expect(r.eventType).toBe("taxonomy_read");
	});

	it("classifies a router page read as router_read", () => {
		const r = classifySkillPath(`${ROOT}/repo-skills-router/SKILL.md`, ROOT);
		expect(r.matched).toBe(true);
		expect(r.eventType).toBe("router_read");
	});

	it("classifies a root SKILL.md", () => {
		const r = classifySkillPath(`${ROOT}/repo-skills/rdkit/SKILL.md`, ROOT);
		expect(r.matched).toBe(true);
		expect(r.eventType).toBe("skill_root_read");
		expect(r.skillId).toBe("rdkit");
	});

	it("classifies a sub-skill SKILL.md", () => {
		const r = classifySkillPath(`${ROOT}/repo-skills/rdkit/sub-skills/molecule-io/SKILL.md`, ROOT);
		expect(r.matched).toBe(true);
		expect(r.eventType).toBe("sub_skill_read");
		expect(r.skillId).toBe("rdkit");
		expect(r.subSkillId).toBe("molecule-io");
	});

	it("classifies a reference read", () => {
		const r = classifySkillPath(`${ROOT}/repo-skills/rdkit/references/workflows.md`, ROOT);
		expect(r.matched).toBe(true);
		expect(r.eventType).toBe("reference_read");
		expect(r.skillId).toBe("rdkit");
	});

	it("classifies a script file read as script_read (not script_call)", () => {
		const r = classifySkillPath(`${ROOT}/repo-skills/rdkit/scripts/fingerprint_smoke.py`, ROOT);
		expect(r.matched).toBe(true);
		expect(r.eventType).toBe("script_read");
		expect(r.skillId).toBe("rdkit");
	});

	it("returns unmatched for unrelated paths", () => {
		const r = classifySkillPath(`/home/u/work/project/src/foo.ts`, ROOT);
		expect(r.matched).toBe(false);
	});

	it("handles Windows backslash-normalized root and path", () => {
		const winRoot = ROOT.replaceAll("/", "\\");
		const r = classifySkillPath(`${winRoot}\\repo-skills\\rdkit\\references\\workflows.md`, winRoot);
		expect(r.matched).toBe(true);
		expect(r.eventType).toBe("reference_read");
		expect(r.skillId).toBe("rdkit");
	});
});

describe("computeUsageMetrics", () => {
	it("computes follow-through conservatively", () => {
		const events: RepoSkillEvent[] = [
			routerRow({ sessionId: "s1" }),
			routerRow({ eventType: "skill_root_read", skillId: "alpha", sessionId: "s1" }),
			routerRow({ eventType: "skill_root_read", skillId: "beta", sessionId: "s2" }),
		];
		const m = computeUsageMetrics(events);
		expect(m.routerReadSessions).toBe(1);
		expect(m.routerFollowthroughSessions).toBe(1);
		expect(m.routerFollowthroughRate).toBe(1);
		expect(m.distinctSkills).toBe(2);
	});

	it("returns null taskSuccessRate when no judgements exist", () => {
		const events: RepoSkillEvent[] = [routerRow({ eventType: "run_settled", technicalStatus: "completed" })];
		const m = computeUsageMetrics(events);
		expect(m.taskSuccessRate).toBeNull();
		expect(m.runSettledByStatus["completed"]).toBe(1);
	});

	it("computes script failure rate", () => {
		const events: RepoSkillEvent[] = [
			routerRow({ eventType: "script_call", skillId: "alpha", isError: false }),
			routerRow({ eventType: "script_call", skillId: "alpha", isError: true }),
		];
		const m = computeUsageMetrics(events);
		expect(m.scriptCallCount).toBe(2);
		expect(m.scriptFailureRate).toBe(0.5);
	});

	it("taskSuccessRate ignores un-gradeable judgement rows (mirrors ledger projection)", () => {
		const mk = (over: Partial<RepoSkillEvent>) =>
			routerRow({ eventType: "task_judgement", skillId: "alpha", judgementSource: "human", taskScore: 0.8, ...over });
		const events: RepoSkillEvent[] = [
			mk({ taskScore: 0.9 }), // valid
			mk({ skillId: undefined }), // missing skillId -> not projected
			mk({ judgementSource: "none" }), // source "none" -> not projected
			mk({ taskScore: 1.5 }), // out of [0,1] -> not projected
			mk({ taskScore: undefined }), // score-less -> not projected
		];
		const m = computeUsageMetrics(events);
		// Only the single valid row (0.9) contributes to both numerator and denominator.
		expect(m.taskSuccessRate).toBe(0.9);
	});

	it("taskSuccessRate is null when no judgement is gradeable", () => {
		const events: RepoSkillEvent[] = [
			routerRow({ eventType: "task_judgement", skillId: "alpha", judgementSource: "none", taskScore: 0.8 }),
			routerRow({ eventType: "task_judgement", skillId: undefined, judgementSource: "human", taskScore: 0.5 }),
		];
		const m = computeUsageMetrics(events);
		expect(m.taskSuccessRate).toBeNull();
	});
});

describe("ObserverWriter", () => {
	it("flushes queued rows to a JSONL file and reads them back", () => {
		const dir = join(makeTmp(), "events");
		const w = new ObserverWriter({ dir, flushIntervalMs: 0 });
		w.enqueue(routerRow({ eventId: "e1" }));
		w.flush();
		w.close();
		expect(readdirSync(dir).filter((n) => n.endsWith(".jsonl")).length).toBe(1);
		const { events, malformed } = readAllEvents(dir);
		expect(malformed).toBe(0);
		expect(events).toHaveLength(1);
		expect(events[0].eventId).toBe("e1");
	});

	it("counts dropped events on a bad write path without throwing", () => {
		const parent = join(makeTmp(), "drop");
		const dir = join(parent, "events");
		mkdirSync(parent, { recursive: true });
		const w = new ObserverWriter({ dir, flushIntervalMs: 0 });
		w.enqueue(routerRow());
		// Replace the events dir with a plain file so appendFileSync fails.
		rmSync(dir, { recursive: true, force: true });
		writeFileSync(dir, "x", "utf8");
		expect(() => w.flush()).not.toThrow();
		const h: ObserverHealth = w.snapshotHealth();
		expect(h.droppedEvents).toBeGreaterThan(0);
		expect(h.totalEvents).toBeGreaterThan(0);
		w.close();
		rmSync(dir, { force: true });
	});
});

describe("RepoSkillObserver integration", () => {
	it("writes classified read, script, and settled rows", () => {
		const dir = join(makeTmp(), "events");
		const obs = new RepoSkillObserver({
			eventsDir: dir,
			repoSkillsRoot: ROOT,
			flushIntervalMs: 0,
		});

		obs.onToolCall({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "read",
			input: { path: `${ROOT}/repo-skills/rdkit/SKILL.md` },
		} as never);
		obs.onToolResult({
			type: "tool_result",
			toolCallId: "c2",
			toolName: "bash",
			input: { command: `python ${ROOT}/repo-skills/rdkit/scripts/fingerprint_smoke.py` },
			content: [],
			isError: false,
		} as never);
		obs.onRunSettled({ type: "agent_settled" } as never);
		obs.close();

		const { events } = readAllEvents(dir);
		const types = events.map((e) => e.eventType).sort();
		expect(types).toContain("skill_root_read");
		expect(types).toContain("script_call");
		expect(types).toContain("run_settled");
		const settled = events.find((e) => e.eventType === "run_settled");
		expect(settled?.technicalStatus).toBe("completed");
	});

	it("does not record non-repo-skill tool calls", () => {
		const dir = join(makeTmp(), "events");
		const obs = new RepoSkillObserver({
			eventsDir: dir,
			repoSkillsRoot: ROOT,
			flushIntervalMs: 0,
		});
		obs.onToolCall({
			type: "tool_call",
			toolCallId: "c3",
			toolName: "read",
			input: { path: `/home/u/work/project/src/foo.ts` },
		} as never);
		obs.close();
		const { events } = readAllEvents(dir);
		expect(events).toHaveLength(0);
	});
});

describe("BUG-P1-03: writer persists lifetime health snapshot", () => {
	it("writes health.json on flush", () => {
		const dir = join(makeTmp(), "health");
		const w = new ObserverWriter({ dir, flushIntervalMs: 0 });
		w.enqueue(routerRow({ eventId: "e1" }));
		w.flush();
		const raw = readFileSync(join(dir, "health.json"), "utf8");
		const h = JSON.parse(raw) as ObserverHealth;
		expect(h.totalEvents).toBe(1);
		expect(h.lastWriteMs).toBeGreaterThan(0);
		w.close();
	});

	it("persists health again on close even with an empty queue", () => {
		const dir = join(makeTmp(), "health-close");
		const w = new ObserverWriter({ dir, flushIntervalMs: 0 });
		w.enqueue(routerRow({ eventId: "e1" }));
		w.close();
		const first = JSON.parse(readFileSync(join(dir, "health.json"), "utf8")) as ObserverHealth;
		// A second, fresh writer over the same dir picks up the persisted counters.
		const w2 = new ObserverWriter({ dir, flushIntervalMs: 0 });
		const h2: ObserverHealth = w2.snapshotHealth();
		expect(h2.totalEvents).toBe(0);
		w2.close();
		expect(first.totalEvents).toBe(1);
	});
});

describe("BUG-P1-02: writer close is idempotent and enqueue-after-close is a no-op", () => {
	it("does not double-persist or throw on repeated close", () => {
		const dir = join(makeTmp(), "idem");
		const w = new ObserverWriter({ dir, flushIntervalMs: 0 });
		w.enqueue(routerRow({ eventId: "e1" }));
		expect(() => w.close()).not.toThrow();
		expect(() => w.close()).not.toThrow();
		const { events } = readAllEvents(dir);
		expect(events).toHaveLength(1);
	});

	it("drops enqueues after close without crashing", () => {
		const dir = join(makeTmp(), "droppost");
		const w = new ObserverWriter({ dir, flushIntervalMs: 0 });
		w.close();
		expect(() => w.enqueue(routerRow({ eventId: "e2" }))).not.toThrow();
		const h: ObserverHealth = w.snapshotHealth();
		expect(h.totalEvents).toBe(0);
	});
});

describe("BUG-P1-07: concurrent writers never collide on the same JSONL file", () => {
	it("two writers in the same dir produce distinct file names and distinct rows", () => {
		const dir = join(makeTmp(), "multiproc");
		const w1 = new ObserverWriter({ dir, flushIntervalMs: 0 });
		const w2 = new ObserverWriter({ dir, flushIntervalMs: 0 });
		expect(w1.activeFilePath()).not.toBe(w2.activeFilePath());
		w1.enqueue(routerRow({ eventId: "a1", sessionId: "proc1" }));
		w2.enqueue(routerRow({ eventId: "b1", sessionId: "proc2" }));
		w1.flush();
		w2.flush();
		// Each process writes its own file; no interleaving corruption.
		const names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
		expect(names.length).toBeGreaterThanOrEqual(2);
		const { events } = readAllEvents(dir);
		expect(events).toHaveLength(2);
		const sessions = events.map((e) => e.sessionId).sort();
		expect(sessions).toEqual(["proc1", "proc2"]);
		w1.close();
		w2.close();
	});

	it("rotation always produces a fresh name (no same-millisecond reuse)", () => {
		const dir = join(makeTmp(), "rotate-fresh");
		const w = new ObserverWriter({ dir, rotateBytes: 1, flushIntervalMs: 0 }); // rotate after 1 byte
		w.enqueue(routerRow({ eventId: "r1" }));
		w.flush(); // writes events-0.jsonl
		const first = w.activeFilePath();
		w.enqueue(routerRow({ eventId: "r2" }));
		w.flush(); // size>=1 -> rotates to events-1.jsonl
		const second = w.activeFilePath();
		expect(second).not.toBe(first);
		const names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
		expect(names).toHaveLength(2);
		expect(new Set(names).size).toBe(names.length); // every file name unique
		w.close();
	});
});

describe("BUG-P1-04: malformedLines is a lifetime counter, not inflated by scans", () => {
	it("currentMalformed reflects the scan while persisted malformedLines stays stable", () => {
		const dir = join(makeTmp(), "malformed");
		mkdirSync(dir, { recursive: true });
		// Persist a health file whose lifetime malformedLines is, say, 4.
		const persisted: ObserverHealth = {
			totalEvents: 12,
			droppedEvents: 0,
			malformedLines: 4,
			lastWriteMs: 1000,
			startedMs: 0,
		};
		writeHealthFile(dir, persisted);
		// One valid row + one malformed line in an event file.
		writeFileSync(join(dir, "events-1.jsonl"), `${JSON.stringify(routerRow({ eventId: "ok" }))}\nnot-json\n`, "utf8");

		const r1 = buildUsageReport(dir);
		// Once: 1 malformed line found at scan, lifetime counter unchanged.
		expect(r1.currentMalformed).toBe(1);
		expect(r1.health.malformedLines).toBe(4);

		// Running the report again must NOT grow the lifetime counter.
		const r2 = buildUsageReport(dir);
		expect(r2.health.malformedLines).toBe(4);

		// And the persisted health file is untouched (the cumulative value is preserved).
		const reread = JSON.parse(readFileSync(join(dir, "health.json"), "utf8")) as ObserverHealth;
		expect(reread.malformedLines).toBe(4);
	});

	it("judgements.provenance.jsonl is not read as an event stream (no malformed inflation)", () => {
		const dir = join(makeTmp(), "provenance");
		mkdirSync(dir, { recursive: true });
		// A real judgement row plus its best-effort authoring provenance sibling.
		writeFileSync(join(dir, "judgements.jsonl"), `${JSON.stringify(routerRow({ eventId: "j1", eventType: "task_judgement", skillId: "alpha", judgementSource: "human", taskScore: 0.8 }))}\n`, "utf8");
		writeFileSync(join(dir, "judgements.provenance.jsonl"), `${JSON.stringify({ eventId: "j1", skillId: "alpha", source: "human", score: 0.8 })}\n`, "utf8");

		const { events, malformed } = readAllEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].eventType).toBe("task_judgement");
		// The provenance line (non-event schema) must NOT be counted as malformed.
		expect(malformed).toBe(0);
	});
});

describe("BUG-P1-05: reading a script file records script_read, not script_call", () => {
	it("a read tool_call into scripts/ produces script_read", () => {
		const dir = join(makeTmp(), "scriptread");
		const obs = new RepoSkillObserver({ eventsDir: dir, repoSkillsRoot: ROOT, flushIntervalMs: 0 });
		obs.onToolCall({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "read",
			input: { path: `${ROOT}/repo-skills/rdkit/scripts/fingerprint_smoke.py` },
		} as never);
		obs.close();
		const { events } = readAllEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].eventType).toBe("script_read");
		expect(events[0].skillId).toBe("rdkit");
	});

	it("only a bash tool_result yields script_call", () => {
		const dir = join(makeTmp(), "scriptcall");
		const obs = new RepoSkillObserver({ eventsDir: dir, repoSkillsRoot: ROOT, flushIntervalMs: 0 });
		obs.onToolResult({
			type: "tool_result",
			toolCallId: "c2",
			toolName: "bash",
			input: { command: `python ${ROOT}/repo-skills/rdkit/scripts/fingerprint_smoke.py` },
			content: [],
			isError: false,
		} as never);
		obs.close();
		const { events } = readAllEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].eventType).toBe("script_call");
	});

	it("script_read counts toward skillsUsed but not scriptCallCount", () => {
		const m = computeUsageMetrics([
			routerRow({ eventType: "script_read", skillId: "alpha" }),
			routerRow({ eventType: "script_call", skillId: "alpha", isError: false }),
		]);
		expect(m.skillsUsed).toBe(1);
		expect(m.scriptCallCount).toBe(1);
		expect(m.scriptFailureRate).toBe(0);
	});
});

describe("BUG-P1-06: relative paths resolve against the handler cwd", () => {
	it("resolves a relative read path through cwd", () => {
		const dir = join(makeTmp(), "relread");
		const cwd = "/home/u/work";
		const obs = new RepoSkillObserver({ eventsDir: dir, repoSkillsRoot: ROOT, flushIntervalMs: 0 });
		// `../.disco` from /home/u/work lands in /home/u then under the repos root.
		obs.onToolCall(
			{
				type: "tool_call",
				toolCallId: "c1",
				toolName: "read",
				input: { path: `../.disco/agent/skills/repositories/repo-skills/rdkit/SKILL.md` },
			} as never,
			cwd,
		);
		obs.close();
		const { events } = readAllEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].eventType).toBe("skill_root_read");
		expect(events[0].skillId).toBe("rdkit");
	});

	it("resolves a relative bash script path through cwd as script_call", () => {
		const dir = join(makeTmp(), "relbash");
		const cwd = "/home/u/work";
		const obs = new RepoSkillObserver({ eventsDir: dir, repoSkillsRoot: ROOT, flushIntervalMs: 0 });
		obs.onToolResult(
			{
				type: "tool_result",
				toolCallId: "c2",
				toolName: "bash",
				input: { command: `python ../.disco/agent/skills/repositories/repo-skills/rdkit/scripts/fingerprint_smoke.py` },
				content: [],
				isError: false,
			} as never,
			cwd,
		);
		obs.close();
		const { events } = readAllEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].eventType).toBe("script_call");
		expect(events[0].skillId).toBe("rdkit");
	});
});


