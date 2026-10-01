/**
 * Step 5 预埋 — Skill-tree promotion TRANSACTION interface skeleton.
 *
 * Defines the contract (acquire → stage → apply → commit / rollback) that a full
 * Step 5 implementation will back with `RepoSkillsLibraryManager`'s
 * lock/backup/rollback machinery. This module ships a guarded factory that
 * REFUSES to do anything unless BOTH an explicit human approval reference AND a
 * real manager adapter are supplied. No filesystem mutation happens here by
 * default — it is a contract, not a runner.
 */

import type { EvolveProposal } from "./types.ts";

export type ApplyResult =
	| { ok: true; note: string }
	| { ok: false; reason: string };

/**
 * Backend that a full Step 5 would wire to RepoSkillsLibraryManager's private
 * lock/backup/rollback. Supplying one is the deliberate explicit consent to run
 * transaction machinery; absent it, apply() always refuses.
 */
export interface ManagerTransactionAdapter {
	readonly name: string;
	applyPatch(proposal: EvolveProposal): ApplyResult;
	rollback(): void;
}

export interface TransactionContext {
	/** Human approval reference (e.g. a review ticket id). Required to proceed. */
	humanApprovalRef?: string;
	/** Real manager-backed adapter. Required to proceed. */
	adapter?: ManagerTransactionAdapter;
}

export interface PromotionTransaction {
	acquire(targetSkillId: string): boolean;
	stage(proposal: EvolveProposal): void;
	apply(): ApplyResult;
	rollback(): void;
	get state(): "idle" | "staged" | "applied" | "rolled-back";
}

/**
 * Factory for the transaction skeleton. Without an adapter AND a humanApprovalRef
 * it returns a transaction whose apply() always refuses; it never touches any
 * skill file on its own.
 */
export function createPromotionTransaction(ctx: TransactionContext): PromotionTransaction {
	let state: PromotionTransaction["state"] = "idle";
	let stagedProposal: EvolveProposal | undefined;

	return {
		get state() {
			return state;
		},
		acquire(targetSkillId: string): boolean {
			if (!ctx.adapter || !ctx.humanApprovalRef) return false; // no backend / no human gate
			void targetSkillId;
			state = "idle";
			return true;
		},
		stage(proposal: EvolveProposal): void {
			stagedProposal = proposal;
			state = "staged";
		},
		// NOTE (deferred, P2-05): if adapter.applyPatch THROWS after partially
		// applying, state stays "staged" and rollback() is not auto-invoked — a
		// partial commit would survive unless the caller manually rolls back.
		// Deliberately not auto-try/catch here because the transaction adapter is
		// still a contract skeleton (drill uses an idempotent fake; no real Step 5
		// manager throws today), and auto-rollback semantics for a partially
		// applied patch are manager-specific. Callers must wrap apply() and call
		// rollback() on throw until a real adapter lands.
		apply(): ApplyResult {
			if (!ctx.humanApprovalRef) return { ok: false, reason: "human approval required: no auto-promotion (Step 5 is human-gated)." };
			if (!ctx.adapter) return { ok: false, reason: "no manager transaction adapter wired; refusing to touch the live tree." };
			if (state !== "staged" || !stagedProposal) return { ok: false, reason: "no staged proposal to apply." };
			const result = ctx.adapter.applyPatch(stagedProposal);
			if (result.ok) state = "applied";
			return result;
		},
		rollback(): void {
			try {
				ctx.adapter?.rollback();
			} finally {
				// Mark the rollback as done even when the adapter THROWS. Reporting the
				// pre-rollback state ("staged"/"applied") after a failed restore would
				// let a later apply() re-run against a partially-reverted tree while
				// `get state` claims nothing changed. The throw still propagates.
				state = "rolled-back";
				stagedProposal = undefined;
			}
		},
	};
}
