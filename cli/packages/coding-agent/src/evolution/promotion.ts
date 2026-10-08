/**
 * P1-05: the human-gated promotion of a candidate into the live library.
 *
 * The audit found `createPromotionTransaction` was a contract with no production
 * caller: `requestPromotion` returned a verdict and stopped, `tryApply` was
 * hard-wired to `false`, and nothing connected `RepoSkillsLibraryManager`. This
 * module closes that gap with an append-only ledger and an orchestrator that
 * keeps the three outcomes the report asks for strictly separate:
 *
 *   1. approval succeeded  (`approval` record — written BEFORE the live tree moves)
 *   2. the live file commit succeeded (`file-commit` record)
 *   3. post-promotion verification succeeded (`post-verification` record)
 *
 * Every refusal is recorded too (`refusal`), so a rejected promotion is an
 * auditable outcome rather than a silent no-op, and the rejection branch never
 * touches the live tree.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteFileSync } from "../audit/atomic.ts";
import { assertCanonicalId } from "../audit/id.ts";
import { RepoSkillsLibraryError, RepoSkillsLibraryManager } from "../core/repo-skills-library-manager.ts";
import { skillTreeDigest } from "./skill-patch.ts";
import {
	type RsiEpisode,
	transitionEpisode,
	saveEpisode,
	recordEpisodeStep,
	stopEpisode,
} from "./episode.ts";

export const PROMOTION_RECORD_SCHEMA = "ocsid.promotion-record.v1" as const;

export type PromotionRecordKind = "approval" | "file-commit" | "post-verification" | "rollback" | "refusal";

export interface PromotionRecord {
	schema: typeof PROMOTION_RECORD_SCHEMA;
	recordId: string;
	prevRecordId: string | null;
	at: string;
	kind: PromotionRecordKind;
	episodeId: string;
	skillId: string;
	/** The human decision that licensed (or refused) the change. */
	approval?: { reference: string; note?: string };
	candidate?: {
		candidateId: string;
		stagedRoot: string;
		manifestFile: string;
		parentSkillDigest: string;
		patchDigest: string;
		resultSkillDigest: string;
	};
	acceptance?: {
		verdict: "accepted" | "rejected";
		delta: number | null;
		parentMean: number | null;
		candidateMean: number | null;
		regressedCases: string[];
	};
	commit?: {
		previousDigest?: string;
		installedDigest: string;
		fileCount: number;
		backupPath?: string;
		transactionRoot: string;
		libraryCommit: string;
		liveTreeDigest: string;
	};
	verification?: {
		runId: string;
		status: string;
		score: number | null;
		verdict: "pass" | "fail";
		evidenceRef: string;
		newSessionId?: string;
	};
	reason?: string;
}

export function promotionLedgerPath(qualityDir: string): string {
	return path.join(path.resolve(qualityDir), "promotions.jsonl");
}

export function readPromotionLedger(qualityDir: string): PromotionRecord[] {
	const target = promotionLedgerPath(qualityDir);
	if (!fs.existsSync(target)) return [];
	const records: PromotionRecord[] = [];
	for (const [index, line] of fs.readFileSync(target, "utf8").split(/\r?\n/).entries()) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(`invalid promotion ledger ${target} line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const record = parsed as PromotionRecord;
		if (record.schema !== PROMOTION_RECORD_SCHEMA || typeof record.recordId !== "string") {
			throw new Error(`invalid promotion ledger ${target} line ${index + 1}: not a ${PROMOTION_RECORD_SCHEMA} record`);
		}
		records.push(record);
	}
	return records;
}

/** Append one record, chaining it to the previous one so the ledger is tamper-evident. */
export function appendPromotionRecord(
	qualityDir: string,
	record: Omit<PromotionRecord, "schema" | "recordId" | "prevRecordId" | "at"> & { at?: string },
): PromotionRecord {
	const existing = readPromotionLedger(qualityDir);
	const prevRecordId = existing.length > 0 ? existing[existing.length - 1]?.recordId ?? null : null;
	const at = record.at ?? new Date().toISOString();
	const body = { ...record, at, prevRecordId };
	const recordId = createHash("sha256").update(JSON.stringify(body)).digest("hex");
	const full: PromotionRecord = { schema: PROMOTION_RECORD_SCHEMA, recordId, ...body, prevRecordId };
	const target = promotionLedgerPath(qualityDir);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.appendFileSync(target, `${JSON.stringify(full)}\n`, "utf8");
	return full;
}

export interface PostPromotionVerification {
	runId: string;
	status: string;
	score: number | null;
	evidenceRef: string;
	newSessionId?: string;
	verifierSha256?: string | null;
}

export interface PromoteEpisodeOptions {
	qualityDir: string;
	episode: RsiEpisode;
	/** The explicit human approval. Empty/whitespace is refused. */
	approval: { reference: string; note?: string };
	manager?: RepoSkillsLibraryManager;
	/**
	 * Run the same case against the NEWLY INSTALLED live skill in a fresh session.
	 * Required to reach `verified`: the report's chain ends in "new session
	 * re-verification", so a commit alone must not be reported as success.
	 */
	verifyAfterPromotion?: (context: { skillId: string; liveSkillRoot: string; skillDigest: string }) => Promise<PostPromotionVerification>;
	now?: () => Date;
}

export interface PromoteEpisodeResult {
	episode: RsiEpisode;
	approvalRecord: PromotionRecord;
	commitRecord?: PromotionRecord;
	verificationRecord?: PromotionRecord;
	rollbackRecord?: PromotionRecord;
	refused?: string;
}

function refusal(
	options: PromoteEpisodeOptions,
	reason: string,
	kind: PromotionRecordKind = "refusal",
): PromoteEpisodeResult {
	const record = appendPromotionRecord(options.qualityDir, {
		kind,
		episodeId: options.episode.episodeId,
		skillId: options.episode.skillId,
		reason,
		...(options.approval.reference.trim() !== "" ? { approval: { reference: options.approval.reference, ...(options.approval.note ? { note: options.approval.note } : {}) } } : {}),
	});
	const episode = saveEpisode(
		options.qualityDir,
		stopEpisode(
			recordEpisodeStep(options.episode, { step: "promotion", status: "failed", detail: reason }),
			"failure",
			reason,
		),
		options.now,
	);
	return { episode, approvalRecord: record, refused: reason };
}

export async function promoteEpisode(options: PromoteEpisodeOptions): Promise<PromoteEpisodeResult> {
	const { episode } = options;
	const reference = options.approval.reference.trim();
	if (episode.phase !== "awaiting-approval") {
		return refusal(options, `promotion requires an episode that is awaiting approval (current phase: ${episode.phase})`);
	}
	if (reference === "") {
		return refusal(options, "promotion requires a non-empty human approval reference (a live change is never silent)");
	}
	const candidate = episode.candidate;
	if (!candidate) return refusal(options, "promotion requires an authored candidate (run the candidate step first)");
	const acceptance = episode.acceptance;
	if (!acceptance) return refusal(options, "promotion requires a recorded acceptance gate (run the acceptance step first)");
	if (acceptance.verdict !== "accepted") {
		return refusal(options, `acceptance gate rejected this candidate: ${acceptance.reasons.join("; ") || "no reason recorded"}`);
	}
	if (acceptance.scoreSource !== "workspace-verifier") {
		return refusal(options, "promotion requires independent workspace-verifier grading; legacy or proxy-only acceptance must be re-evaluated");
	}
	const manager = options.manager ?? new RepoSkillsLibraryManager();
	if (!(manager instanceof RepoSkillsLibraryManager)) {
		return refusal(options, "promotion requires a RepoSkillsLibraryManager transaction adapter");
	}

	// 1. The human decision is recorded BEFORE anything moves.
	const approvalRecord = appendPromotionRecord(options.qualityDir, {
		kind: "approval",
		episodeId: episode.episodeId,
		skillId: episode.skillId,
		approval: { reference, ...(options.approval.note ? { note: options.approval.note } : {}) },
		candidate: {
			candidateId: candidate.candidateId,
			stagedRoot: candidate.stagedRoot,
			manifestFile: candidate.manifestFile,
			parentSkillDigest: candidate.manifest.parentSkillDigest,
			patchDigest: candidate.manifest.patchDigest,
			resultSkillDigest: candidate.manifest.resultSkillDigest,
		},
		acceptance: {
			verdict: acceptance.verdict,
			delta: acceptance.delta,
			parentMean: acceptance.parentMean,
			candidateMean: acceptance.candidateMean,
			regressedCases: acceptance.regressedCases,
		},
	});
	let moving = transitionEpisode(episode, "promotion", `human approval ${reference}`);
	moving = saveEpisode(options.qualityDir, moving, options.now);

	// 2. The live file commit. The parent-version check runs UNDER the live lock,
	//    so a concurrent install/update cannot invalidate it between check and swap.
	let committed;
	try {
		committed = await manager.replaceSkill({
			skillId: episode.skillId,
			stagedSkillRoot: candidate.stagedRoot,
			validate: (context) => {
				if (!context.liveSkillRoot) return `live skill "${episode.skillId}" does not exist in the installed library`;
				const live = skillTreeDigest(context.liveSkillRoot);
				if (live !== candidate.manifest.parentSkillDigest) {
					return `parent skill "${episode.skillId}" changed since the candidate was authored (live digest ${live}, candidate parent ${candidate.manifest.parentSkillDigest}); re-author the candidate against the current skill`;
				}
				return undefined;
			},
		});
	} catch (error) {
		if (error instanceof RepoSkillsLibraryError) {
			return refusal(options, `live file commit refused: ${error.message}`);
		}
		throw error;
	}

	// 3. Read back what actually landed. The manager reports its own tree digest
	//    (`sha256:<hex>`), which is a different algorithm from the candidate
	//    manifest's bare sha256, so compare on the evolution side: a commit whose
	//    live tree is not the tree the manifest promised is undone immediately.
	const liveDigestAfterCommit = skillTreeDigest(committed.liveSkillRoot);
	if (liveDigestAfterCommit !== candidate.manifest.resultSkillDigest) {
		await undoCommit(options, episode, committed, `the committed live tree ${liveDigestAfterCommit} is not the candidate tree the manifest promised (${candidate.manifest.resultSkillDigest})`);
		return refusal(
			options,
			`the committed live tree ${liveDigestAfterCommit} is not the candidate tree the manifest promised (${candidate.manifest.resultSkillDigest}); the promotion was undone`,
		);
	}
	const commitRecord = appendPromotionRecord(options.qualityDir, {
		kind: "file-commit",
		episodeId: episode.episodeId,
		skillId: episode.skillId,
		approval: { reference, ...(options.approval.note ? { note: options.approval.note } : {}) },
		candidate: {
			candidateId: candidate.candidateId,
			stagedRoot: candidate.stagedRoot,
			manifestFile: candidate.manifestFile,
			parentSkillDigest: candidate.manifest.parentSkillDigest,
			patchDigest: candidate.manifest.patchDigest,
			resultSkillDigest: candidate.manifest.resultSkillDigest,
		},
		commit: {
			previousDigest: candidate.manifest.parentSkillDigest,
			installedDigest: liveDigestAfterCommit,
			fileCount: committed.installed.fileCount,
			...(committed.backupPath ? { backupPath: committed.backupPath } : {}),
			transactionRoot: committed.transactionRoot,
			libraryCommit: (manager.status().commit ?? "unknown"),
			liveTreeDigest: committed.liveTreeDigest,
		},
	});
	moving = transitionEpisode(
		recordEpisodeStep(moving, { step: "promotion", status: "succeeded", detail: `installed ${committed.installed.digest}`, evidenceRef: promotionLedgerPath(options.qualityDir) }),
		"post-verification",
	);
	moving = saveEpisode(options.qualityDir, moving, options.now);

	// 3. New-session re-verification against the live tree.
	if (!options.verifyAfterPromotion) {
		// The file move is real, so the episode records it — but with no
		// post-verification runner the episode must NOT claim "verified": the step
		// is recorded as skipped and the episode stays at post-verification.
		const stopped = saveEpisode(
			options.qualityDir,
			{
				...recordEpisodeStep(moving, { step: "post-verification", status: "skipped", detail: "no verification runner supplied" }),
				promotion: {
					approvalRef: reference,
					at: commitRecord.at,
					recordId: commitRecord.recordId,
					previousDigest: candidate.manifest.parentSkillDigest,
					installedDigest: liveDigestAfterCommit,
					...(committed.backupPath ? { backupPath: committed.backupPath } : {}),
				},
			},
			options.now,
		);
		return { episode: stopped, approvalRecord, commitRecord };
	}
	const liveSkillRoot = committed.liveSkillRoot;
	let verification: PostPromotionVerification;
	let verificationError: string | undefined;
	try {
		verification = await options.verifyAfterPromotion({
			skillId: episode.skillId,
			liveSkillRoot,
			skillDigest: liveDigestAfterCommit,
		});
	} catch (error) {
		verificationError = error instanceof Error ? error.message : String(error);
		verification = {
			runId: `${episode.episodeId}-post-verify`,
			status: "failed",
			score: null,
			evidenceRef: promotionLedgerPath(options.qualityDir),
		};
	}
	const verdict: "pass" | "fail" = verification.status === "succeeded" && verification.score === 1 &&
		/^[0-9a-f]{64}$/.test(verification.verifierSha256 ?? "") ? "pass" : "fail";
	const verificationRecord = appendPromotionRecord(options.qualityDir, {
		kind: "post-verification",
		episodeId: episode.episodeId,
		skillId: episode.skillId,
		approval: { reference, ...(options.approval.note ? { note: options.approval.note } : {}) },
		verification: { ...verification, verdict },
		...(verificationError ? { reason: verificationError } : {}),
	});
	let after = recordEpisodeStep(moving, {
		step: "post-verification",
		status: verdict === "pass" ? "succeeded" : "failed",
		detail: `${verification.runId} score=${String(verification.score)}`,
		evidenceRef: verification.evidenceRef,
	});
	if (verdict === "pass") {
		const episode = saveEpisode(
			options.qualityDir,
			stopEpisode(
				{ ...after, promotion: { approvalRef: reference, at: verificationRecord.at, recordId: commitRecord.recordId, previousDigest: candidate.manifest.parentSkillDigest, installedDigest: liveDigestAfterCommit, ...(committed.backupPath ? { backupPath: committed.backupPath } : {}), postVerification: { at: verificationRecord.at, runId: verification.runId, status: verification.status, score: verification.score, verdict, recordId: verificationRecord.recordId } } },
				"completed",
				"promoted and re-verified in a new session",
			),
			options.now,
		);
		return { episode, approvalRecord, commitRecord, verificationRecord };
	}

	// A failed re-verification must not leave the promoted tree live.
	const rollback = await rollbackPromotion({
		qualityDir: options.qualityDir,
		episode: after,
		reason: `post-promotion verification failed (${verification.runId}: status=${verification.status}, score=${String(verification.score)})${verificationError ? `: ${verificationError}` : ""}`,
		manager,
		...(committed.backupPath ? { backupPath: committed.backupPath } : {}),
		now: options.now,
	});
	return { episode: rollback.episode, approvalRecord, commitRecord, verificationRecord, rollbackRecord: rollback.record };
}

export interface RollbackPromotionOptions {
	qualityDir: string;
	episode: RsiEpisode;
	reason: string;
	/** Explicit backup root (from the commit record); otherwise the latest commit is used. */
	backupPath?: string;
	manager?: RepoSkillsLibraryManager;
	now?: () => Date;
}

/**
 * Undo a `file-commit` whose live tree did not come out as the candidate manifest
 * promised. The restore runs through the same atomic `replaceSkill` path, so the
 * undo is itself transactional and leaves a `rollback` record behind. Returns
 * `undefined` when no usable backup exists — the caller must then say so loudly
 * rather than pretend the tree was restored.
 */
async function undoCommit(
	options: PromoteEpisodeOptions,
	episode: RsiEpisode,
	committed: { backupPath?: string; liveSkillRoot: string },
	reason: string,
): Promise<PromotionRecord | undefined> {
	const backupSkillRoot = committed.backupPath ? path.join(committed.backupPath, "repo-skills", episode.skillId) : undefined;
	if (!backupSkillRoot || !fs.existsSync(backupSkillRoot)) return undefined;
	const manager = options.manager ?? new RepoSkillsLibraryManager();
	const restored = await manager.restoreSkill(episode.skillId, backupSkillRoot);
	return appendPromotionRecord(options.qualityDir, {
		kind: "rollback",
		episodeId: episode.episodeId,
		skillId: episode.skillId,
		commit: {
			installedDigest: skillTreeDigest(restored.liveSkillRoot),
			fileCount: restored.installed.fileCount,
			...(restored.backupPath ? { backupPath: restored.backupPath } : {}),
			transactionRoot: restored.transactionRoot,
			libraryCommit: manager.status().commit ?? "unknown",
			liveTreeDigest: restored.liveTreeDigest,
		},
		reason,
	});
}

/** Restore the skill tree a `file-commit` record replaced, through the same transaction path. */
export async function rollbackPromotion(	options: RollbackPromotionOptions,
): Promise<{ episode: RsiEpisode; record: PromotionRecord }> {
	const reason = options.reason.trim();
	if (reason === "") throw new Error("a rollback requires a reason");
	const records = readPromotionLedger(options.qualityDir);
	const commit = [...records].reverse().find((record) =>
		record.kind === "file-commit" && record.episodeId === options.episode.episodeId &&
		record.skillId === options.episode.skillId &&
		(options.backupPath === undefined || record.commit?.backupPath === options.backupPath));
	if (!commit?.commit) throw new Error(`no matching promotion commit for episode ${options.episode.episodeId}; cannot select another episode's backup`);
	const backupPath = options.backupPath ?? commit?.commit?.backupPath;
	if (!backupPath) throw new Error(`no promotion backup found for skill ${options.episode.skillId}; nothing to roll back`);
	const skillId = commit?.skillId ?? options.episode.skillId;
	const backupSkillRoot = path.join(backupPath, "repo-skills", skillId);
	if (!fs.existsSync(backupSkillRoot)) throw new Error(`promotion backup does not contain ${skillId}: ${backupSkillRoot}`);
	const manager = options.manager ?? new RepoSkillsLibraryManager();
	const restored = await manager.restoreSkill(skillId, backupSkillRoot, (context) => {
		if (!context.liveSkillRoot || skillTreeDigest(context.liveSkillRoot) !== commit.commit?.installedDigest) {
			return `live skill ${skillId} changed since episode ${options.episode.episodeId} committed; refusing to overwrite a different version`;
		}
		return undefined;
	});
	const record = appendPromotionRecord(options.qualityDir, {
		kind: "rollback",
		episodeId: options.episode.episodeId,
		skillId,
		commit: {
			installedDigest: skillTreeDigest(restored.liveSkillRoot),
			fileCount: restored.installed.fileCount,
			...(restored.backupPath ? { backupPath: restored.backupPath } : {}),
			transactionRoot: restored.transactionRoot,
			libraryCommit: manager.status().commit ?? "unknown",
			liveTreeDigest: restored.liveTreeDigest,
		},
		reason,
	});
	const episode = saveEpisode(
		options.qualityDir,
		stopEpisode(
			recordEpisodeStep(options.episode, { step: "rollback", status: "succeeded", detail: reason, evidenceRef: promotionLedgerPath(options.qualityDir) }),
			"failure",
			reason,
		),
		options.now,
	);
	return { episode, record };
}

export function assertPromotionSkillId(skillId: string): void {
	assertCanonicalId(skillId, "skillId");
}
