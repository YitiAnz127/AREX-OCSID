/**
 * Step 5 预埋 — human-gated promotion INTERFACE (contract only, no live-tree apply).
 *
 * This module defines what a promotion *request* looks like and the gate rules.
 * It does NOT apply anything to the live skill tree. Real application is the job
 * of `repo-skills-library-manager`'s lock/transaction/rollback (Step 5 full) and
 * is deliberately out of scope here.
 *
 * Safety contract:
 *  - A promotion is refused unless an explicit human approval is carried.
 *  - There is no code path that auto-approves or silently promotes.
 */

import type { EvolveProposal } from "./types.ts";

export interface PromotionRequest {
	proposal: EvolveProposal;
	/** A human-verifiable note about what would change (for review). */
	changeNote: string;
	/** Backing metric rationale (a baseline-plumbing note is NOT a sufficient rationale). */
	rationale: string;
}

export type PromotionVerdict =
	| { approved: false; reason: string }
	| { approved: true; note: string };

/**
 * Evaluate whether a proposal may be *considered* for promotion. Always refuses
 * without an explicit `humanApproved` flag, and even on approval it only returns
 * a verdict — it never mutates the live tree. The mock apply hook is omitted so
 * there is no accidental path to changing skills from this module.
 */
export function requestPromotion(
	req: PromotionRequest,
	opts: { humanApproved: boolean },
): PromotionVerdict {
	if (!opts.humanApproved) {
		return {
			approved: false,
			reason: "human approval required: propose-only evolution never auto-promotes a candidate without explicit human confirmation.",
		};
	}
	// `rationale` is declared above as a gate input ("a baseline-plumbing note is
	// NOT a sufficient rationale") but was never read — the verdict turned on the
	// humanApproved flag alone, so an approval with no recorded justification passed
	// the gate for a self-modifying pipeline. Require it to carry actual content.
	if (!req.rationale || req.rationale.trim().length === 0) {
		return {
			approved: false,
			reason: "promotion requires a backing-metric rationale; an empty rationale does not justify changing a live skill.",
		};
	}
	// Still only a verdict: application is a separate Step 5 transactional action.
	return {
		approved: true,
		note: `promotion APPROVED for consideration (human-gated) — ${req.changeNote}. Application is a separate transactional step, not performed here.`,
	};
}
