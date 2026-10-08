/**
 * Step 4 — propose-only evolution contract.
 *
 * This module is deliberately *propose-only*. It may PLAN a candidate change
 * for a skill (hypothesis + evidence + concrete plan) but it can NEVER apply
 * that change to the live skill tree. Promotion is the job of Step 5
 * (`evaluate/promote`) and requires explicit human confirmation. There is no
 * auto-promotion transition anywhere in `src/evolution/`.
 */

/** Phase of an evolution round in the controller state machine. */
export type EvolutionPhase =
	| "idle"
	| "planning"
	| "proposing"
	| "archived";

/** Legal phase transitions (no promote/auto anywhere). */
export const EVOLUTION_TRANSITIONS: Record<EvolutionPhase, readonly EvolutionPhase[]> = {
	idle: ["planning"],
	planning: ["proposing"],
	proposing: ["archived"],
	archived: [],
};

export interface EvolutionRound {
	/** Stable id for the round, e.g. "evolve-r1". */
	id: string;
	/** Target skill the proposal addresses. */
	targetSkillId: string;
	/** Phase of this round. */
	phase: EvolutionPhase;
	/** Optional blocker/failure reason when a transition is refused. */
	blocker?: string;
}

export interface ProposalEvidence {
	/** Observation source (e.g. "quality-ledger" / "usage-metrics"). */
	source: string;
	/** Human-readable finding that motivates the change. */
	finding: string;
	/** Whether the finding is an empirical result (must be false by default). */
	empirical: boolean;
	/**
	 * Reference task_success_rate / metric that motivated the proposal, or
	 * null. Stored as a *hypothesis input*, never as an achieved improvement.
	 */
	referenceMetric?: number | null;
}

export interface EvolveProposal {
	schema: "ocsid.evolution-proposal.v1";
	roundId: string;
	targetSkillId: string;
	/** One-line hypothesis about what change might help. */
	hypothesis: string;
	/** Concrete, human-reviewable change plan (files/areas to touch). */
	plan: string[];
	/** Why now: evidence motivating the proposal. */
	evidence: ProposalEvidence;
	/** ISO timestamp; deterministic for the CLI baseline (not Date.now()). */
	generatedAt: string;
	/**
	 * Propose-only invariant: this is ALWAYS false. A proposal never touches
	 * the live skill tree. Step 5 promotion is a separate, human-gated step.
	 */
	appliedToLiveTree: false;
	/** Genealogy: the round id this proposal derives from, if any (lineage for later attribution). */
	parentRoundId?: string;
	/** Genealogy: generation depth (root proposals are generation 0). */
	generation?: number;
}
