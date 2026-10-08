/**
 * P1-04: the episode runner — the "unified orchestration" the audit found missing.
 *
 * It walks ONE persistent episode through the chain the report asks for:
 *
 *   evidence -> probe -> diagnosis -> candidate -> regression -> acceptance
 *
 * and stops honestly at every branch: a U0 `abstain`/`probe` decision ends the
 * episode without touching a skill, a failed regression ends it, and only an
 * ACCEPTED candidate reaches `awaiting-approval` (which is where a human, not
 * this code, decides — see `promotion.ts`).
 *
 * Two deliberate constraints:
 *  - the patch is an INPUT here (a JSON file authored by the operator). The audit
 *    asked for a fixed patcher bound into the loop; inventing the patch text
 *    inside the loop would make the evidence un-reviewable.
 *  - the acceptance gate uses real paired runs on real sessions, with the same
 *    config/verifier for both legs, and never counts a missing score as a zero.
 */
import fs from "node:fs";
import path from "node:path";
import {
	type AgentDriver,
	type AgentEvalResult,
	type AgentExecutionConfig,
	runAgentEval,
} from "../audit/agent-executor.ts";
import { assertCanonicalId, assertCaseId } from "../audit/id.ts";
import { loadWorkspaceVerifier } from "../audit/workspace-verifier.ts";
import { checkCaseFiles } from "../audit/runner.ts";
import { atomicWriteFileSync } from "../audit/atomic.ts";
import { diagnoseWithU0, U0_POLICY, type DiagnosticDecision, type DiagnosticEvidence } from "./diagnostic-policy.ts";
import { runCandidateAuthor } from "./candidate-cli.ts";
import {
	type EpisodeAcceptance,
	type EpisodeBudget,
	type EpisodeCandidate,
	type EpisodeCaseDelta,
	type EpisodeRegression,
	type RsiEpisode,
	appendEpisodeLog,
	chargeEpisodeBudget,
	chargeEpisodeRun,
	pairedEpisodeConfig,
	canFundEpisodeRun,
	createEpisode,
	episodeDir,
	readEpisode,
	recordEpisodeStep,
	saveEpisode,
	stopEpisode,
	transitionEpisode,
} from "./episode.ts";
import { probeReportPath, runReferenceAdditionProbes, withProbe } from "./probe.ts";

export interface EpisodeRunOptions {
	qualityDir: string;
	episodeId: string;
	skillId: string;
	caseId: string;
	/** Parent directory of the skill packages, as `runAgentEval` expects. */
	skillRoot: string;
	/** The failing observation that opened the episode (an audit run's diagnostic evidence). */
	evidence: DiagnosticEvidence;
	/** The case's user request, verbatim. */
	request: string;
	/** Reference material for the "after" probe leg; required to probe. */
	reference?: string;
	assertionsFile?: string;
	verifierFile?: string;
	/** Paired probe repetitions (U0 needs >= U0_POLICY.minimumPairedProbes to license a patch). */
	probePairs?: number;
	/** Patch (JSON `{ "ops": [...] }`) applied by the fixed patcher to author the candidate. */
	patchFile: string;
	author?: string;
	patchReason?: string;
	stagingDir?: string;
	/** Extra case ids to regress over; the episode's own case is always included. */
	cases?: string[];
	/** Contains <caseId>/{user_request.txt,assertions.json,verifier.json}. */
	casesRoot?: string;
	config: AgentExecutionConfig;
	driverFactory: () => AgentDriver;
	budget?: Partial<EpisodeBudget>;
	now?: () => Date;
}

export interface EpisodeRunResult {
	episode: RsiEpisode;
	probeReportPath?: string;
	diagnosis?: DiagnosticDecision;
	candidate?: EpisodeCandidate;
	regression?: EpisodeRegression;
}

export function episodeProbeEvidencePath(qualityDir: string, episodeId: string): string {
	return path.join(episodeDir(qualityDir, episodeId), "probe-evidence.json");
}

function scoreFromEvidence(run: AgentEvalResult): number | null {
	if (!fs.existsSync(run.diagnosticEvidencePath)) return null;
	const evidence = JSON.parse(fs.readFileSync(run.diagnosticEvidencePath, "utf8")) as DiagnosticEvidence;
	return typeof evidence.score === "number" ? evidence.score : null;
}

function mean(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The budget a paired regression consumes. The candidate/probe allowances are
 * deliberately NOT consulted here: they were already charged when those steps
 * ran, and reaching a cap must not discard a regression that just produced data.
 */
function regressionBudgetStop(state: RsiEpisode): string | undefined {
	const b = state.budget;
	if (b.wallMs >= b.maxWallMs) return `wall-time budget spent (${b.wallMs}ms/${b.maxWallMs}ms)`;
	if (b.tokens >= b.maxTokens) return `token budget spent (${b.tokens}/${b.maxTokens})`;
	return undefined;
}

interface RegressionCase {
	caseId: string;
	userRequest: string;
	assertionsText?: string;
	verifierFile?: string;
}

function loadRegressionCases(options: EpisodeRunOptions): RegressionCase[] {
	const ids = [...new Set([options.caseId, ...(options.cases ?? [])])];
	if (ids.length > 1 && !options.casesRoot) throw new Error("extra case IDs require casesRoot (--cases-root) with each case's actual files");
	return ids.map((caseId) => {
		assertCaseId(caseId);
		if (!options.casesRoot) {
			if (options.verifierFile) loadWorkspaceVerifier(options.verifierFile);
			return { caseId, userRequest: options.request,
				...(options.assertionsFile ? { assertionsText: fs.readFileSync(options.assertionsFile, "utf8") } : {}),
				...(options.verifierFile ? { verifierFile: options.verifierFile } : {}) };
		}
		const root = fs.realpathSync(options.casesRoot);
		const readPath = (name: string): string => {
			const file = path.join(root, ...caseId.split("/"), name);
			const real = fs.realpathSync(file);
			if (!real.startsWith(root + path.sep) || !fs.lstatSync(file).isFile()) throw new Error(`invalid case file: ${file}`);
			return real;
		};
		const userRequest = fs.readFileSync(readPath("user_request.txt"), "utf8");
		const assertionsText = fs.readFileSync(readPath("assertions.json"), "utf8");
		const checked = checkCaseFiles({ userRequest, assertionsText });
		if (!checked.ok) throw new Error(`${caseId}: ${checked.reason}`);
		const verifierFile = readPath("verifier.json");
		loadWorkspaceVerifier(verifierFile);
		return { caseId, userRequest, assertionsText, verifierFile };
	});
}

/**
 * Run one episode to a terminal or approval-ready state. The returned episode is
 * also persisted, so `episode status` can read it back after a crash.
 */
export async function runEpisode(options: EpisodeRunOptions): Promise<EpisodeRunResult> {
	assertCanonicalId(options.episodeId, "episodeId");
	assertCanonicalId(options.skillId, "skillId");
	assertCaseId(options.caseId);
	const regressionCases = loadRegressionCases(options);
	const primaryCase = regressionCases[0]!;
	const now = options.now ?? (() => new Date());
	const statePath = path.join(episodeDir(options.qualityDir, options.episodeId), "episode.json");
	let state = fs.existsSync(statePath)
		? readEpisode(options.qualityDir, options.episodeId)
		: createEpisode({
				qualityDir: options.qualityDir,
				episodeId: options.episodeId,
				skillId: options.skillId,
				caseId: options.caseId,
				...(options.budget ? { budget: options.budget } : {}),
				now,
			});
	const save = (next: RsiEpisode): RsiEpisode => {
		state = saveEpisode(options.qualityDir, next, now);
		return state;
	};
	const stop = (kind: "abstain" | "budget" | "failure", reason: string, current: RsiEpisode): RsiEpisode => {
		const stopped = save(stopEpisode(recordEpisodeStep(current, { step: current.phase, status: "skipped", detail: reason }), kind, reason));
		appendEpisodeLog(options.qualityDir, stopped, { step: "stop", at: stopped.stop?.at ?? now().toISOString(), status: "failed", detail: reason });
		return stopped;
	};

	// ---- step 1: evidence -> probe -------------------------------------------------
	if (state.phase === "evidence") {
		if (!primaryCase.verifierFile) {
			return finish(stop("abstain", "independent workspace verifier is required before spending the episode budget", state), options);
		}
		if (!options.reference || options.reference.trim() === "") {
			return finish(stop("abstain", "no reference material supplied; a controlled reference-addition probe cannot be run, so U0 has nothing to decide on", state), options);
		}
		// The shared budget is checked BEFORE a step spends, so an episode that has
		// already spent its probe allowance cannot quietly buy another one.
		const pairs = options.probePairs ?? U0_POLICY.minimumPairedProbes;
		const probeBudget = pairs > state.budget.maxProbePairs - state.budget.probePairs
			? "requested probe pairs exceed the remaining probe allowance"
			: !pairedEpisodeConfig(state, options.config) ? "shared budget cannot fund a paired probe" : undefined;
		if (probeBudget) return finish(stop("budget", `no probe budget left: ${probeBudget}`, state), options);
		state = save(transitionEpisode(state, "probe", "running controlled reference-addition probes"));
		const probe = await runReferenceAdditionProbes({
			qualityDir: options.qualityDir,
			episodeId: options.episodeId,
			skillId: options.skillId,
			caseId: options.caseId,
			skillRoot: options.skillRoot,
			request: primaryCase.userRequest,
			reference: options.reference,
			pairs,
			config: options.config,
			driverFactory: options.driverFactory,
			...(primaryCase.assertionsText ? { assertionsText: primaryCase.assertionsText } : {}),
			...(primaryCase.verifierFile ? { verifierFile: primaryCase.verifierFile } : {}),
			executionBudget: {
				nextPairConfig: () => state.budget.probePairs >= state.budget.maxProbePairs ? undefined : pairedEpisodeConfig(state, options.config),
				canRun: (config) => canFundEpisodeRun(state, config),
				startPair: () => { save(chargeEpisodeBudget(state, { probePairs: 1 })); },
				charge: (usage, config) => { save(chargeEpisodeRun(state, usage, config)); },
			},
		});
		const evidenceWithProbe = withProbe(options.evidence, probe.probe);
		atomicWriteFileSync(episodeProbeEvidencePath(options.qualityDir, options.episodeId), `${JSON.stringify(evidenceWithProbe, null, 2)}\n`, "utf8");
		state = save({
			...state,
			probeEvidence: evidenceWithProbe,
			probe: { ...probe.probe, meanGain: probe.report.meanGain },
		});
		const reason = probe.budgetStop ?? regressionBudgetStop(state);
		if (reason) {
			// Over-spending the shared budget does not erase a controlled probe, but
			// it does stop the episode before any candidate is authored.
			return finish(stop("budget", reason, state), options);
		}
		if (!probe.report.controlled) {
			return finish(stop("abstain", `probe is not controlled: ${probe.report.reason}`, state), options);
		}
	}

	// ---- step 2: probe -> diagnosis ------------------------------------------------
	if (state.phase === "probe") {
		const probeEvidence = state.probeEvidence;
		if (!probeEvidence) return finish(stop("failure", "probe evidence is missing from the episode state", state), options);
		state = save(transitionEpisode(state, "diagnosis", `U0 ${U0_POLICY.version}`));
		const diagnosis = diagnoseWithU0(probeEvidence);
		state = save({ ...state, diagnosis });
		appendEpisodeLog(options.qualityDir, state, {
			step: "diagnosis",
			at: now().toISOString(),
			status: diagnosis.decision === "patch" ? "succeeded" : "skipped",
			detail: `${diagnosis.diagnosis}/${diagnosis.decision}: ${diagnosis.reason}`,
		});
		if (diagnosis.decision !== "patch") {
			return finish(stop("abstain", `U0 decided ${diagnosis.diagnosis}/${diagnosis.decision}: ${diagnosis.reason}`, state), options);
		}
	}

	// ---- step 3: diagnosis -> candidate (fixed patcher) ----------------------------
	if (state.phase === "diagnosis") {
		// Same rule as the probe step: an episode that already spent its candidate
		// allowance must not author another one. Reaching the cap while authoring
		// THIS candidate is fine — the accepted candidate still has to be evaluated.
		const candidateBudget = state.budget.candidates >= state.budget.maxCandidates
			? "candidate budget spent" : regressionBudgetStop(state);
		if (candidateBudget) return finish(stop("budget", `no candidate budget left: ${candidateBudget}`, state), options);
		state = save(transitionEpisode(state, "candidate", "authoring the candidate from the supplied patch"));
		const authored = runCandidateAuthor({
			skillId: options.skillId,
			// The patcher works on ONE skill tree; `options.skillRoot` is the parent
			// directory that `runAgentEval` snapshots from, so join the skill id here.
			skillRoot: path.join(path.resolve(options.skillRoot), options.skillId),
			patchFile: path.resolve(options.patchFile),
			author: options.author ?? "ocsid-episode",
			reason: options.patchReason ?? state.diagnosis?.reason ?? "U0 approved a persistent patch",
			...(options.stagingDir ? { stagingDir: path.resolve(options.stagingDir) } : {}),
			out: episodeDir(options.qualityDir, options.episodeId),
		});
		const manifest = JSON.parse(fs.readFileSync(authored.manifestFile, "utf8")) as EpisodeCandidate["manifest"];
		const candidate: EpisodeCandidate = {
			candidateId: authored.candidateId,
			stagedRoot: authored.stagedRoot,
			manifestFile: authored.manifestFile,
			manifest,
		};
		if (manifest.parentSkillDigest !== state.probeEvidence?.skillDigest) {
			return finish(
				stop("failure", `the live skill changed while the episode ran (probe digest ${state.probeEvidence?.skillDigest ?? "missing"}, candidate parent ${manifest.parentSkillDigest})`, state),
				options,
			);
		}
		state = save(chargeEpisodeBudget({ ...state, candidate }, { candidates: 1 }));
	}

	// ---- step 4: candidate -> regression (real paired runs) ------------------------
	if (state.phase === "candidate") {
		const candidate = state.candidate;
		if (!candidate) return finish(stop("failure", "candidate state is missing", state), options);
		state = save(transitionEpisode(state, "regression", `${regressionCases.length} paired case(s)`));
		const deltas: EpisodeCaseDelta[] = [];
		for (const [index, testCase] of regressionCases.entries()) {
			const { caseId, assertionsText, verifierFile } = testCase;
			const config = pairedEpisodeConfig(state, options.config);
			if (!config) return finish(stop("budget", "shared budget cannot fund another regression pair", state), options);
			const caseInput = {
				skillId: options.skillId,
				caseId,
				userRequest: testCase.userRequest,
				...(assertionsText !== undefined ? { assertionsText } : {}),
			};
			const parent = await runAgentEval({
				qualityDir: options.qualityDir,
				runId: `${options.episodeId}-reg${index + 1}-parent`,
				skillId: options.skillId,
				caseId,
				skillRoot: path.resolve(options.skillRoot),
				...(verifierFile ? { verifierFile } : {}),
				config,
				driver: options.driverFactory(),
				adhocCase: caseInput,
			});
			save(chargeEpisodeRun(state, parent.usage, config));
			if (!canFundEpisodeRun(state, config)) return finish(stop("budget", "shared budget spent before candidate regression leg", state), options);
			const candidateRun = await runAgentEval({
				qualityDir: options.qualityDir,
				runId: `${options.episodeId}-reg${index + 1}-candidate`,
				skillId: options.skillId,
				caseId,
				skillRoot: path.resolve(options.skillRoot),
				candidate: { manifestFile: candidate.manifestFile, stagedRoot: candidate.stagedRoot },
				...(verifierFile ? { verifierFile } : {}),
				config,
				driver: options.driverFactory(),
				adhocCase: caseInput,
			});
			save(chargeEpisodeRun(state, candidateRun.usage, config));
			if (parent.configDigest !== candidateRun.configDigest || parent.verifierSha256 !== candidateRun.verifierSha256) {
				return finish(stop("failure", `paired regression configuration or verifier changed between legs (case ${caseId})`, state), options);
			}
			deltas.push({
				caseId,
				parentStatus: parent.status,
				candidateStatus: candidateRun.status,
				parentScore: scoreFromEvidence(parent),
				candidateScore: scoreFromEvidence(candidateRun),
				parentRunId: parent.runId,
				candidateRunId: candidateRun.runId,
				verifierSha256: parent.verifierSha256,
			});
		}
		const budgetReason = regressionBudgetStop(state);
		if (budgetReason) return finish(stop("budget", budgetReason, state), options);
		const completePairs = deltas.filter((pair) => pair.parentStatus === "succeeded" && pair.candidateStatus === "succeeded" &&
			pair.parentScore !== null && pair.candidateScore !== null);
		const parentScores = completePairs.map((pair) => pair.parentScore!);
		const candidateScores = completePairs.map((pair) => pair.candidateScore!);
		const parentMean = mean(parentScores);
		const candidateMean = mean(candidateScores);
		const regression: EpisodeRegression = {
			runId: `${options.episodeId}-regression`,
			cases: deltas,
			parentMean,
			candidateMean,
			delta: parentMean !== null && candidateMean !== null ? candidateMean - parentMean : null,
			regressedCases: deltas
				.filter((delta) => delta.parentScore !== null && delta.candidateScore !== null && delta.candidateScore < delta.parentScore)
				.map((delta) => delta.caseId),
		};
		state = save({ ...state, regression });

		// ---- step 5: regression -> acceptance --------------------------------------
		state = save(transitionEpisode(state, "acceptance", "evaluating the acceptance gate"));
		const reasons: string[] = [];
		for (const pair of deltas) {
			if (pair.parentStatus !== "succeeded" || pair.candidateStatus !== "succeeded" ||
				pair.parentScore === null || pair.candidateScore === null) {
				reasons.push(`${pair.caseId}: incomplete or failed paired execution (parent=${pair.parentStatus}, candidate=${pair.candidateStatus}); missing scores cannot be excluded`);
			}
			if (!pair.verifierSha256) reasons.push(`${pair.caseId}: independent workspace verifier is missing`);
		}
		if (regression.regressedCases.length > 0) reasons.push(`candidate regressed on ${regression.regressedCases.join(", ")}`);
		if (parentMean === null || candidateMean === null) reasons.push("the paired regression did not produce scores on both sides");
		else if (regression.delta === null || regression.delta <= 0) reasons.push(`candidate did not improve the mean score (delta ${String(regression.delta)})`);
		const acceptance: EpisodeAcceptance = {
			verdict: reasons.length === 0 ? "accepted" : "rejected",
			...(deltas.every((pair) => pair.verifierSha256 !== null) ? { scoreSource: "workspace-verifier" as const } : {}),
			reasons,
			parentMean,
			candidateMean,
			delta: regression.delta,
			regressedCases: regression.regressedCases,
		};
		state = save({ ...state, acceptance });
		appendEpisodeLog(options.qualityDir, state, {
			step: "acceptance",
			at: now().toISOString(),
			status: acceptance.verdict === "accepted" ? "succeeded" : "failed",
			detail: `${acceptance.verdict}: ${reasons.join("; ") || "no regression and a positive delta"}`,
		});
		if (acceptance.verdict !== "accepted") {
			return finish(stop("abstain", `acceptance gate rejected the candidate: ${reasons.join("; ")}`, state), options);
		}
		state = save(transitionEpisode(state, "awaiting-approval", "candidate accepted; a human must approve the promotion"));
	}

	return finish(state, options);
}

function finish(state: RsiEpisode, options: EpisodeRunOptions): EpisodeRunResult {
	return {
		episode: state,
		...(fs.existsSync(probeReportPath(options.qualityDir, options.episodeId)) ? { probeReportPath: probeReportPath(options.qualityDir, options.episodeId) } : {}),
		...(state.diagnosis ? { diagnosis: state.diagnosis } : {}),
		...(state.candidate ? { candidate: state.candidate } : {}),
		...(state.regression ? { regression: state.regression } : {}),
	};
}
