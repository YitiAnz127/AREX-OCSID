import { describe, expect, it } from "vitest";
import { createPromotionTransaction, type ManagerTransactionAdapter } from "./transact.ts";
import { makeProposal, type ProposeInput } from "./propose-only.ts";
import type { EvolveProposal } from "./types.ts";

const proposalInput: ProposeInput = { roundId: "r2", targetSkillId: "gget", hypothesis: "h", plan: ["p"], evidence: { source: "s", finding: "f", empirical: false }, generatedAt: "T", parentRoundId: "r1", generation: 1 };

function proposal(): EvolveProposal {
	return makeProposal(proposalInput);
}

describe("promotion transaction skeleton (Step 5 pre-embed)", () => {
	it("refuses apply without human approval even with an adapter", () => {
		const adapter: ManagerTransactionAdapter = { name: "fake", applyPatch: () => ({ ok: true, note: "x" }), rollback: () => undefined };
		const t = createPromotionTransaction({ adapter });
		expect(t.acquire("gget")).toBe(false);
		t.stage(proposal());
		const r = t.apply();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("human approval required");
		expect(t.state).toBe("staged"); // never touched live tree
	});

	it("refuses apply without an adapter even with human approval", () => {
		const t = createPromotionTransaction({ humanApprovalRef: "TKT-1" });
		t.stage(proposal());
		const r = t.apply();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("no manager transaction adapter");
	});

	it("applies only through a real adapter and rolls back", () => {
		let applied = 0;
		let rolled = 0;
		const adapter: ManagerTransactionAdapter = {
			name: "fake",
			applyPatch: () => {
				applied += 1;
				return { ok: true, note: "applied" };
			},
			rollback: () => {
				rolled += 1;
			},
		};
		const t = createPromotionTransaction({ humanApprovalRef: "TKT-1", adapter });
		expect(t.acquire("gget")).toBe(true);
		t.stage(proposal());
		expect(t.apply()).toEqual({ ok: true, note: "applied" });
		expect(t.state).toBe("applied");
		t.rollback();
		expect(t.state).toBe("rolled-back");
		expect(applied).toBe(1);
		expect(rolled).toBe(1);
	});

	it("marks the transaction rolled-back even when the adapter's rollback throws", () => {
		// Reporting the pre-rollback state after a failed restore would let a later
		// apply() re-run against a partially-reverted tree while `state` claims
		// nothing happened.
		const adapter: ManagerTransactionAdapter = {
			name: "fake-throwing",
			applyPatch: () => ({ ok: true, note: "applied" }),
			rollback: () => {
				throw new Error("restore failed halfway");
			},
		};
		const t = createPromotionTransaction({ humanApprovalRef: "TKT-2", adapter });
		expect(t.acquire("gget")).toBe(true);
		t.stage(proposal());
		expect(t.apply()).toEqual({ ok: true, note: "applied" });

		expect(() => t.rollback()).toThrow(/restore failed halfway/);
		// The throw still propagates, but the state must not claim "applied".
		expect(t.state).toBe("rolled-back");
		// A second apply is refused (no staged proposal remains).
		expect(t.apply().ok).toBe(false);
	});
});
