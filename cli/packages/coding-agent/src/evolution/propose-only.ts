/**
 * Propose-only candidate generation.
 *
 * Turns an explicit evidence profile for a target skill into an inert
 * `EvolveProposal` (hypothesis + human-reviewable plan). It makes NO claim that
 * the proposed change improves anything, and it NEVER writes to the live skill
 * tree. Generation is deterministic: the same evidence profile + round id
 * yields byte-identical proposal content.
 *
 * A caller supplies the evidence; this module does not invent it. In practice
 * the evidence comes from the quality ledger's observed failure profile or
 * usage metrics — but only a real (non-baseline) grading run makes that
 * evidence empirical (`evidence.empirical = true`).
 */

import type { EvolveProposal, ProposalEvidence } from "./types.ts";

export interface ProposeInput {
	roundId: string;
	targetSkillId: string;
	/** One-line hypothesis about what change might help. */
	hypothesis: string;
	/** Concrete, human-reviewable change plan (files/areas to touch). */
	plan: string[];
	evidence: ProposalEvidence;
	/** Deterministic timestamp (caller-controlled, NOT Date.now()). */
	generatedAt: string;
	/** Genealogy: parent round this proposal derives from, if any. */
	parentRoundId?: string;
	/** Genealogy: generation depth (root = 0). */
	generation?: number;
}

/**
 * Build a proposal from an evidence profile. `empirical` is forced to true ONLY
 * when the caller explicitly marks the evidence as an observed result; the safe
 * default keeps it false (research note, not fact).
 */
export function makeProposal(input: ProposeInput): EvolveProposal {
	const empirical = input.evidence.empirical === true;
	const proposal: EvolveProposal = {
		schema: "ocsid.evolution-proposal.v1",
		roundId: input.roundId,
		targetSkillId: input.targetSkillId,
		hypothesis: input.hypothesis,
		plan: [...input.plan],
		evidence: {
			...input.evidence,
			empirical,
		},
		generatedAt: input.generatedAt,
		// Propose-only invariant: never applied to the live tree.
		appliedToLiveTree: false,
	};
	if (input.parentRoundId !== undefined) proposal.parentRoundId = input.parentRoundId;
	if (input.generation !== undefined) proposal.generation = input.generation;
	return proposal;
}
