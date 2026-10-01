import { describe, expect, it } from "vitest";
import { EvolutionController, EvolutionControllerError } from "./controller.ts";
import { makeProposal } from "./propose-only.ts";
import type { ProposalEvidence } from "./types.ts";

describe("evolution controller (propose-only)", () => {
	it("walks idle -> planning -> proposing -> archived", () => {
		const ctl = new EvolutionController();
		expect(ctl.getPhase()).toBe("idle");
		ctl.transition("planning");
		ctl.transition("proposing");
		ctl.transition("archived");
		expect(ctl.getPhase()).toBe("archived");
		expect(ctl.snapshot("r1", "chemprop").phase).toBe("archived");
	});

	it("rejects illegal transitions and records a blocker", () => {
		const ctl = new EvolutionController("proposing");
		expect(() => ctl.transition("idle")).toThrow(EvolutionControllerError);
		expect(ctl.snapshot("r1", "gget").blocker).toContain("illegal transition");
	});

	it("refuses any apply/promote action (no auto promotion)", () => {
		const ctl = new EvolutionController();
		expect(ctl.tryApply()).toBe(false);
		expect(ctl.snapshot("r1", "mosaic").blocker).toContain("propose-only");
	});

	it("archived is a terminal phase with no outgoing transition", () => {
		const ctl = new EvolutionController("archived");
		expect(() => ctl.transition("idle")).toThrow();
	});
});

describe("propose-only proposal generation", () => {
	const baseEvidence: ProposalEvidence = { source: "quality-ledger", finding: "low coverage on routine path", empirical: false };

	it("produces an inert proposal that never touches the live tree", () => {
		const p = makeProposal({
			roundId: "evolve-r1",
			targetSkillId: "gget",
			hypothesis: "adding a routine-lookup example may improve discoverability",
			plan: ["add one basic example to sub-skills/gene-annotation/references", "note: proposal only, not applied"],
			evidence: baseEvidence,
			generatedAt: "2026-01-01T00:00:00Z",
		});
		expect(p.schema).toBe("disco.evolution-proposal.v1");
		expect(p.appliedToLiveTree).toBe(false);
		expect(p.evidence.empirical).toBe(false); // default: not an empirical claim
		expect(p.plan.length).toBe(2);
		// A proposal is a plain inert object: it must not contain an apply/promote hook.
		expect(JSON.stringify(p)).not.toContain("apply");
		expect(JSON.stringify(p)).toContain("appliedToLiveTree\":false");
	});

	it("is deterministic for identical evidence + round input", () => {
		const a = makeProposal({ roundId: "r", targetSkillId: "chemprop", hypothesis: "h", plan: ["p1"], evidence: baseEvidence, generatedAt: "T" });
		const b = makeProposal({ roundId: "r", targetSkillId: "chemprop", hypothesis: "h", plan: ["p1"], evidence: baseEvidence, generatedAt: "T" });
		expect(a).toEqual(b);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("marks empirical only when the caller explicitly does so", () => {
		const p = makeProposal({
			roundId: "r",
			targetSkillId: "chemprop",
			hypothesis: "h",
			plan: ["p"],
			evidence: { ...baseEvidence, empirical: true },
			generatedAt: "T",
		});
		expect(p.evidence.empirical).toBe(true);
	});
});
