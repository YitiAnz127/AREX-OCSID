import { describe, expect, it } from "vitest";
import { requestPromotion } from "./promote.ts";
import { makeProposal } from "./propose-only.ts";
import type { EvolveProposal } from "./types.ts";

function sampleProposal(): EvolveProposal {
	return makeProposal({
		roundId: "r1",
		targetSkillId: "gget",
		hypothesis: "h",
		plan: ["p1"],
		evidence: { source: "source1", finding: "f", empirical: false },
		generatedAt: "T",
	});
}

describe("human-gated promotion (Step 5 interface pre-embed)", () => {
	it("refuses every promotion without explicit human approval", () => {
		const verdict = requestPromotion({ proposal: sampleProposal(), changeNote: "c", rationale: "baseline note" }, { humanApproved: false });
		expect(verdict.approved).toBe(false);
		if (!verdict.approved) expect(verdict.reason).toContain("human approval required");
	});

	it("still only returns a verdict on approval — never mutates the live tree", () => {
		const verdict = requestPromotion({ proposal: sampleProposal(), changeNote: "c", rationale: "r" }, { humanApproved: true });
		expect(verdict.approved).toBe(true);
		if (verdict.approved) expect(verdict.note).toContain("separate transactional step");
	});

	it("refuses approval with an empty rationale — the declared gate input must be enforced", () => {
		// `rationale` is documented as a gate input ("a baseline-plumbing note is NOT
		// a sufficient rationale") but was never read, so approval depended on the
		// humanApproved flag alone.
		for (const rationale of ["", "   ", "\n\t"]) {
			const verdict = requestPromotion({ proposal: sampleProposal(), changeNote: "c", rationale }, { humanApproved: true });
			expect(verdict.approved).toBe(false);
			if (!verdict.approved) expect(verdict.reason).toContain("rationale");
		}
	});
});
