/**
 * Production task_judgement feed (BUG-P1-09).
 *
 * The observer only records *technical* facts; it deliberately never infers
 * task success unless a labelled source (assertion / human / grader) provides
 * one. This module is that labelled source: a safe, append-only authoring API
 * for a human reviewer or benchmark runner to write `task_judgement` rows into
 * a DEDICATED judgements ledger (`judgements.jsonl`) in the events dir, so
 * `repo-skills ledger` / report can project real grades without ever modifying
 * the observer's raw rotation files.
 *
 * Honesty contract:
 *  - Rows are written to `judgements.jsonl`, never into the observer's
 *    `events-*.jsonl` rotation stream.
 *  - `readAllEvents(dir)` already picks up all `*.jsonl` files, so the existing
 *    `judgementEventToLedgerRow` projection consumes these rows unchanged.
 *  - Every row is append-only (never rewritten in place) and carries a unique
 *    eventId plus full provenance (source, reviewer, rubric, evidence).
 *  - IDs are canonical-validated (same path-containment rules as the rest of
 *    the audit stack) so a caller cannot escape the events dir.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { assertCanonicalId, assertCaseId } from "../audit/id.ts";
import type { RepoSkillEvent, JudgementSource } from "../extensions/repo-skill-observer/events.ts";

export interface AppendJudgementRequest {
	/** Events dir that also holds the observer rotation files. */
	eventsDir: string;
	runId: string;
	skillId: string;
	caseId: string;
	/** 0..1 task score. */
	score: number;
	/** Labelled judgement source (assertion/human/model_grader). */
	source: JudgementSource;
	/** Optional session/turn context. */
	sessionId?: string;
	turnId?: string;
	/** Optional ISO timestamp; defaults to now. */
	at?: string;
	/** Optional human/grader provenance. */
	reviewerId?: string;
	rubricVersion?: string;
	evidenceRef?: string;
}

/**
 * The only sources that may author a task_judgement row. The reserved "none"
 * marker is deliberately rejected below: a row must carry a labelled grader so
 * it can never be silently persisted as unattributable. Checking membership
 * here (rather than only rejecting "none") also blocks any other runtime
 * string smuggled in across a trust boundary from landing in the ledger.
 */
const ALLOWED_JUDGEMENT_SOURCES: readonly string[] = ["assertion", "human", "model_grader"];

export interface AppendJudgementResult {
	appended: boolean;
	eventId?: string;
	file?: string;
	reason?: string;
}

function validateScore(score: number): void {
	if (!Number.isFinite(score)) throw new Error("score must be a finite number");
	if (score < 0 || score > 1) throw new Error("score must be within [0,1]");
}

function makeEventId(at: string): string {
	return `${at.replace(/[^0-9A-Za-z]/g, "")}-${randomUUID()}`;
}

/**
 * Append one production task_judgement row to the dedicated judgements ledger.
 * Returns `{ appended: false, reason }` on validation/IO failure instead of
 * throwing, so a CI/reviewer harness can surface the exact reason.
 */
export function appendJudgement(req: AppendJudgementRequest): AppendJudgementResult {
	try {
		validateScore(req.score);
		if (typeof req.source !== "string" || !ALLOWED_JUDGEMENT_SOURCES.includes(req.source)) {
			return { appended: false, reason: "judgement source must be a labelled grader (assertion/human/model_grader), not 'none' or an unknown label" };
		}
		// BUG-P0-02: canonical-validate the skill id before touching the fs path.
		assertCanonicalId(req.skillId, "skillId");
		assertCanonicalId(req.runId, "runId");
		assertCaseId(req.caseId);
		if (req.source === "human" && (!req.reviewerId || !req.reviewerId.trim())) {
			return { appended: false, reason: "human judgement requires a reviewer id" };
		}
		// B3 (P0-3): a human judgement must also carry an evidence ref, consistent
		// with the `grade` entry point — a human label without evidence is not an
		// auditable review.
		if (req.source === "human" && (!req.evidenceRef || !req.evidenceRef.trim())) {
			return { appended: false, reason: "human judgement requires an evidence ref" };
		}
	} catch (error) {
		return { appended: false, reason: error instanceof Error ? error.message : String(error) };
	}

	const at = req.at ?? new Date().toISOString();
	const event: RepoSkillEvent = {
		schemaVersion: 1,
		eventId: makeEventId(at),
		ts: at,
		sessionId: req.sessionId ?? "judgement",
		turnId: req.turnId ?? "1",
		eventType: "task_judgement",
		skillId: req.skillId,
		runId: req.runId,
		caseId: req.caseId,
		judgementSource: req.source,
		taskScore: req.score,
		// BUG (unattributed grade): grader provenance lives directly on the row so
		// a judgement can never be persisted without its attribution, even if the
		// best-effort sibling provenance ledger write below fails. The projector
		// ignores these fields, so this does not change ledger projection.
		reviewerId: req.reviewerId,
		rubricVersion: req.rubricVersion,
		evidenceRef: req.evidenceRef,
	};
	const file = join(req.eventsDir, "judgements.jsonl");
	try {
		mkdirSync(req.eventsDir, { recursive: true });
		appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
		// Best-effort authoring provenance ledger for the reviewer/graders.
		try {
			appendFileSync(join(req.eventsDir, "judgements.provenance.jsonl"), JSON.stringify({ eventId: event.eventId, at, runId: req.runId, skillId: req.skillId, caseId: req.caseId, source: req.source, score: req.score, reviewerId: req.reviewerId, rubricVersion: req.rubricVersion, evidenceRef: req.evidenceRef }) + "\n", "utf8");
		} catch {
			// provenance file is best-effort only; attribution already rides on the row.
		}
		return { appended: true, eventId: event.eventId, file };
	} catch {
		return { appended: false, reason: `unable to append judgement to ${file}` };
	}
}
