/**
 * Evolution controller — a propose-only state machine.
 *
 * Moves a round through `idle → planning → proposing → archived` and REFUSES any
 * transition that would apply a change to the live skill tree or auto-promote.
 * Promotion (`evaluate/promote`) belongs to Step 5 and is deliberately absent
 * from this module; any call that tries to "apply" a proposal throws.
 */

import { EVOLUTION_TRANSITIONS, type EvolutionPhase, type EvolutionRound } from "./types.ts";

export class EvolutionControllerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvolutionControllerError";
	}
}

export class EvolutionController {
	private phase: EvolutionPhase;
	private blocker?: string;

	constructor(initial: EvolutionPhase = "idle") {
		this.phase = initial;
	}

	/** Current round snapshot (phase may be read before transitioning). */
	snapshot(roundId: string, targetSkillId: string): EvolutionRound {
		return { id: roundId, targetSkillId, phase: this.phase, blocker: this.blocker };
	}

	/** Move to `next` only if it is a legal transition from the current phase. */
	transition(next: EvolutionPhase): void {
		const allowed = EVOLUTION_TRANSITIONS[this.phase];
		if (!allowed.includes(next)) {
			this.blocker = `illegal transition ${this.phase} -> ${next} (propose-only: no apply/promote path)`;
			throw new EvolutionControllerError(this.blocker);
		}
		this.phase = next;
		this.blocker = undefined;
	}

	getPhase(): EvolutionPhase {
		return this.phase;
	}

	/**
	 * Hard guard: there is no path that applies a proposal to the live tree.
	 * Any caller attempting to promote/apply is rejected here. Returns false and
	 * records a blocker rather than throwing, so tooling can surface it.
	 */
	tryApply(): false {
		this.blocker = "propose-only: apply/promote is a Step 5 human-gated action, not available in evolution controller";
		return false;
	}
}
