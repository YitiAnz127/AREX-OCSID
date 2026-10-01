/**
 * Derived metrics over RepoSkill observation rows.
 *
 * These are COMPUTED metrics — each is only meaningful under the documented
 * condition. A key invariant from the RSI plan: a `run_settled` row NEVER
 * implies task success. Success-oriented metrics (`taskSuccessRate`) require
 * explicit judgement rows and return `null` otherwise, so callers cannot
 * mistake absence of a judgement for a failure.
 */

import type { RepoSkillEvent } from "./events.ts";

export interface RepoUsageMetrics {
	/** Count of observation rows that mention any repo skill id. */
	skillRowCount: number;
	/** Distinct repo skill ids observed. */
	distinctSkills: number;
	/** Sessions that read the router. */
	routerReadSessions: number;
	/** Sessions that both read the router and later read a skill root.
	 *  Ratio routerFollowthroughRate = followed / routerReadSessions. */
	routerFollowthroughSessions: number;
	routerFollowthroughRate: number | null;
	/** Distinct skills that produced a reference_read or script_call. */
	skillsUsed: number;
	/** skillsUsed / distinctSkills (0 when none). */
	skillUseRate: number;
	/** script_call rows that errored / total script_call rows. */
	scriptFailureRate: number;
	/** Number of script_call rows observed. */
	scriptCallCount: number;
	/** run_settled rows, grouped by technicalStatus. */
	runSettledByStatus: Record<string, number>;
	/** task_success_rate — null unless task_judgement rows exist. */
	taskSuccessRate: number | null;
}

/**
 * Compute usage metrics from a list of observation rows.
 *
 * Follow-through is intentionally conservative: a session only counts as
 * "followed through" if it contains a `router_read` AND, later, a
 * `skill_root_read`. This avoids inflating the metric with skills read
 * without consulting the router.
 */
export function computeUsageMetrics(events: RepoSkillEvent[]): RepoUsageMetrics {
	const skillIds = new Set<string>();
	const sessionsTouchingRouter = new Set<string>();
	const sessionsFollowedThrough = new Set<string>();
	const skillsWithRootRead = new Set<string>();
	const skillsUsed = new Set<string>();
	let scriptCalls = 0;
	let scriptErrors = 0;
	const runSettledByStatus: Record<string, number> = {};
	let judgementRows = 0;
	let judgementScoreSum = 0;

	for (const e of events) {
		if (e.skillId) skillIds.add(e.skillId);
		if (e.eventType === "router_read") {
			sessionsTouchingRouter.add(e.sessionId);
		}
		if (e.eventType === "skill_root_read" && e.skillId) {
			skillsWithRootRead.add(e.skillId);
			if (sessionsTouchingRouter.has(e.sessionId)) {
				sessionsFollowedThrough.add(e.sessionId);
			}
		}
		if (
			(e.eventType === "reference_read" || e.eventType === "script_call" || e.eventType === "script_read") &&
			e.skillId
		) {
			skillsUsed.add(e.skillId);
		}
		if (e.eventType === "script_call") {
			scriptCalls += 1;
			if (e.isError) scriptErrors += 1;
		}
		if (e.eventType === "run_settled" && e.technicalStatus) {
			runSettledByStatus[e.technicalStatus] = (runSettledByStatus[e.technicalStatus] ?? 0) + 1;
		}
		if (e.eventType === "task_judgement") {
			// Contract mirrored from benchmark/ledger.ts judgementEventToLedgerRow:
			// only rows carrying a real grade (non-"none" source, numeric 0..1 score,
			// and a skillId) count toward taskSuccessRate. Earlier this incremented
			// judgementRows for EVERY task_judgement row but only added taskScore when
			// it was a number, so a score-less / out-of-range / "none"-source row
			// polluted the denominator and the rate disagreed with the ledger.
			if (
				e.judgementSource !== undefined &&
				e.judgementSource !== "none" &&
				typeof e.taskScore === "number" &&
				e.taskScore >= 0 &&
				e.taskScore <= 1 &&
				e.skillId
			) {
				judgementRows += 1;
				judgementScoreSum += e.taskScore;
			}
		}
	}

	const distinctSkills = skillIds.size;
	const routerSessions = sessionsTouchingRouter.size;
	const followedSessions = sessionsFollowedThrough.size;
	const skillsUsedCount = skillsUsed.size;

	return {
		skillRowCount: events.filter((e) => Boolean(e.skillId)).length,
		distinctSkills,
		routerReadSessions: routerSessions,
		routerFollowthroughSessions: followedSessions,
		routerFollowthroughRate: routerSessions > 0 ? followedSessions / routerSessions : null,
		skillsUsed: skillsUsedCount,
		skillUseRate: distinctSkills > 0 ? skillsUsedCount / distinctSkills : 0,
		scriptFailureRate: scriptCalls > 0 ? scriptErrors / scriptCalls : 0,
		scriptCallCount: scriptCalls,
		runSettledByStatus,
		taskSuccessRate: judgementRows > 0 ? judgementScoreSum / judgementRows : null,
	};
}
