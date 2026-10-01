import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJudgement, type AppendJudgementRequest } from "./judgement-feed.ts";

function makeReq(overrides: Partial<AppendJudgementRequest> = {}): AppendJudgementRequest {
	return {
		eventsDir: join(tmpdir(), `judgement-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`),
		skillId: "skill-a",
		runId: "review-1",
		caseId: "root/example-case",
		score: 0.8,
		source: "human",
		reviewerId: "reviewer-1",
		evidenceRef: "ev/1",
		...overrides,
	};
}

describe("appendJudgement (BUG-P1-09)", () => {
	beforeEach(() => {
		rmSync(makeReq().eventsDir, { recursive: true, force: true });
	});

	afterEach(() => {
		rmSync(makeReq().eventsDir, { recursive: true, force: true });
	});

	it("appends a well-formed task_judgement to judgements.jsonl", () => {
		const req = makeReq();
		const res = appendJudgement(req);
		expect(res.appended).toBe(true);
		expect(res.eventId).toBeTruthy();
		expect(res.file).toContain("judgements.jsonl");

		const file = join(req.eventsDir, "judgements.jsonl");
		expect(existsSync(file)).toBe(true);
		const row = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]);
		expect(row.eventType).toBe("task_judgement");
		expect(row.skillId).toBe("skill-a");
		expect(row.runId).toBe("review-1");
		expect(row.caseId).toBe("root/example-case");
		expect(row.taskScore).toBe(0.8);
		expect(row.judgementSource).toBe("human");
		expect(row.eventId).toBe(res.eventId);
		expect(row.schemaVersion).toBe(1);
	});

	it("rejects a human judgement without reviewer attribution", () => {
		const req = makeReq({ reviewerId: undefined });
		const result = appendJudgement(req);
		expect(result.appended).toBe(false);
		expect(result.reason).toMatch(/reviewer/i);
	});

	it("B3: rejects a human judgement without an evidence ref (consistency with grade)", () => {
		const req = makeReq({ evidenceRef: undefined });
		const result = appendJudgement(req);
		expect(result.appended).toBe(false);
		expect(result.reason).toMatch(/evidence/i);
	});

	it("rejects missing or unsafe benchmark identity", () => {
		for (const overrides of [{ runId: undefined }, { caseId: undefined }, { caseId: "root/../escape" }]) {
			const req = makeReq(overrides);
			expect(appendJudgement(req).appended).toBe(false);
		}
	});

	it("rejects a 'none' judgement source without appending", () => {
		const req = makeReq({ source: "none" as never });
		const res = appendJudgement(req);
		expect(res.appended).toBe(false);
		expect(res.reason).toMatch(/labelled grader/);
		expect(existsSync(join(req.eventsDir, "judgements.jsonl"))).toBe(false);
	});

	it("rejects an unknown judgement source label (allowlist, not just 'none')", () => {
		const req = makeReq({ source: "garbage" as never });
		const res = appendJudgement(req);
		expect(res.appended).toBe(false);
		expect(res.reason).toMatch(/labelled grader/);
		expect(existsSync(join(req.eventsDir, "judgements.jsonl"))).toBe(false);
	});

	it("rejects an out-of-range score", () => {
		const req = makeReq({ score: 1.5 });
		const res = appendJudgement(req);
		expect(res.appended).toBe(false);
		expect(res.reason).toMatch(/\[0,1\]/);
	});

	it("rejects a non-canonical skill id (BUG-P0-02 containment)", () => {
		const req = makeReq({ skillId: "../escape" });
		const res = appendJudgement(req);
		expect(res.appended).toBe(false);
		expect(res.reason).toBeTruthy();
	});

	it("writes a best-effort provenance file for reviewer/rubric/evidence", () => {
		const req = makeReq({ reviewerId: "reviewer-1", rubricVersion: "v1", evidenceRef: "ev/1" });
		const res = appendJudgement(req);
		expect(res.appended).toBe(true);
		const provFile = join(req.eventsDir, "judgements.provenance.jsonl");
		expect(existsSync(provFile)).toBe(true);
		const line = JSON.parse(readFileSync(provFile, "utf8").trim().split("\n")[0]);
		expect(line.eventId).toBe(res.eventId);
		expect(line.skillId).toBe("skill-a");
		expect(line.source).toBe("human");
		expect(line.reviewerId).toBe("reviewer-1");
		expect(line.rubricVersion).toBe("v1");
		expect(line.evidenceRef).toBe("ev/1");
	});

	it("BUG (attribution): reviewer/rubric/evidence ride on the judgement row itself", () => {
		// Attribution must never be lost even if the sibling provenance write
		// fails, so the grade row carries reviewerId/rubricVersion/evidenceRef.
		const req = makeReq({ reviewerId: "reviewer-9", rubricVersion: "v2", evidenceRef: "ev/9" });
		const res = appendJudgement(req);
		expect(res.appended).toBe(true);
		const row = JSON.parse(readFileSync(join(req.eventsDir, "judgements.jsonl"), "utf8").trim().split("\n")[0]) as Record<string, unknown>;
		expect(row.reviewerId).toBe("reviewer-9");
		expect(row.rubricVersion).toBe("v2");
		expect(row.evidenceRef).toBe("ev/9");
	});

	it("appends repeatedly rather than overwriting (append-only)", () => {
		const req = makeReq({ at: "2026-01-01T00:00:00Z" });
		const r1 = appendJudgement(req);
		const r2 = appendJudgement({ ...req, score: 0.5 });
		expect(r1.appended).toBe(true);
		expect(r2.appended).toBe(true);
		expect(r1.eventId).not.toBe(r2.eventId);
		const rows = readFileSync(join(req.eventsDir, "judgements.jsonl"), "utf8").trim().split("\n");
		expect(rows).toHaveLength(2);
	});
});

describe("judgement-feed output is readable by the ledger projection", () => {
	it("produces a JSONL file readAllEvents would pick up", () => {
		const req = makeReq();
		appendJudgement(req);
		const files = readdirSync(req.eventsDir).filter((f) => f.endsWith(".jsonl"));
		expect(files).toContain("judgements.jsonl");
	});
});
