import { describe, expect, it } from "vitest";
import type { RepoSkillEvent } from "../extensions/repo-skill-observer/events.ts";
import {
	judgementEventToLedgerRow,
	ledgerTaskSuccessRate,
	observerJudgementsToLedger,
} from "./ledger";

function judgement(overrides: Partial<RepoSkillEvent> = {}): RepoSkillEvent {
	return {
		schemaVersion: 1,
		eventId: "evt-1",
		ts: "2026-01-01T00:00:00Z",
		sessionId: "sess-1",
		turnId: "turn-9",
		eventType: "task_judgement",
		skillId: "chemprop",
		judgementSource: "assertion",
		taskScore: 0.8,
		...overrides,
	};
}

describe("observer -> quality ledger projection", () => {
	it("projects a real task_judgement into a ledger row", () => {
		const row = judgementEventToLedgerRow(judgement());
		expect(row).not.toBeNull();
		expect(row!.skillId).toBe("chemprop");
		expect(row!.caseId).toBe("turn-9");
		expect(row!.score).toBe(0.8);
		expect(row!.gradedBy).toBe("assertion");
		expect(row!.candidateSha256).toBeNull();
		expect(row!.artifactSha256).toBeUndefined(); // observer never stores artifacts
	});

	it("uses explicit benchmark run and case identities from a judgement", () => {
		const row = judgementEventToLedgerRow(judgement({ runId: "review-2", caseId: "sub-skills/train/case-a" }));
		expect(row).toMatchObject({ runId: "review-2", caseId: "sub-skills/train/case-a" });
	});

	it("returns null for a non-judgement event", () => {
		expect(judgementEventToLedgerRow(judgement({ eventType: "script_call" } as never))).toBeNull();
	});

	it("returns null when judgementSource is none or missing", () => {
		expect(judgementEventToLedgerRow(judgement({ judgementSource: "none" }))).toBeNull();
		expect(judgementEventToLedgerRow(judgement({ judgementSource: undefined }))).toBeNull();
	});

	it("returns null when taskScore is missing or out of range", () => {
		expect(judgementEventToLedgerRow(judgement({ taskScore: undefined }))).toBeNull();
		expect(judgementEventToLedgerRow(judgement({ taskScore: 1.5 }))).toBeNull();
		expect(judgementEventToLedgerRow(judgement({ taskScore: -0.1 }))).toBeNull();
	});

	it("returns null when no skillId is present", () => {
		expect(judgementEventToLedgerRow(judgement({ skillId: undefined }))).toBeNull();
	});

	it("projects only real grades from a mixed event list", () => {
		const events: RepoSkillEvent[] = [
			judgement({ eventId: "a", taskScore: 0.9 }),
			judgement({ eventId: "b", eventType: "run_settled" } as never),
			judgement({ eventId: "c", judgementSource: "none" }),
			judgement({ eventId: "d", taskScore: 0.5 }),
		];
		const rows = observerJudgementsToLedger(events);
		expect(rows.map((r) => r.score)).toEqual([0.9, 0.5]);
	});

	it("ledgerTaskSuccessRate returns null on no scored rows, mean otherwise", () => {
		expect(ledgerTaskSuccessRate([])).toBeNull();
		expect(ledgerTaskSuccessRate([{ score: null }])).toBeNull();
		expect(ledgerTaskSuccessRate([{ score: 0.8 }, { score: 0.6 }])).toBeCloseTo(0.7);
	});
});
