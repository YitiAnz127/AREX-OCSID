import chalk from "chalk";
import { readFileSync } from "node:fs";
import { APP_NAME, getRsiEventsDir, getRsiHealthPath, getRsiQualityDir } from "../config.ts";
import {
	RepoSkillsLibraryError,
	RepoSkillsLibraryManager,
	type RepoSkillsInstallResult,
	type RepoSkillsLibraryStatus,
	type RepoSkillsRouterToggleResult,
} from "../core/repo-skills-library-manager.ts";
import { buildUsageReport, persistHealth } from "../extensions/repo-skill-observer/report.ts";
import { readAllEvents } from "../extensions/repo-skill-observer/storage.ts";
import { ledgerTaskSuccessRate, observerJudgementsToLedger } from "../benchmark/ledger.ts";
import { auditPreflight, buildBaselineDeps, loadBenchmark } from "../audit/loader.ts";
import { runAudit } from "../audit/runner.ts";
import { persistAuditRun, readArtifacts, resolveAuditRunDir, type ArtifactRow } from "../audit/records.ts";
import { EvolutionController, EvolutionControllerError } from "../evolution/controller.ts";
import { makeProposal, type ProposeInput } from "../evolution/propose-only.ts";
import { compareBaselines } from "../evolution/baseline.ts";
import { structureGrader } from "../audit/structure-grader.ts";
import { runCandidateEval, runHeldoutFinalEval, HELDOUT_FINAL_EVAL_KIND } from "../evolution/candidate-eval.ts";
import { runAgentEval, DEFAULT_AGENT_CONFIG } from "../audit/agent-executor.ts";
import { ModelAgentDriver } from "../audit/model-agent-driver.ts";
import { runCandidateRegression, type CandidateFamilyMember } from "../evolution/candidate-regression.ts";
import { listCandidateRuns, poolByFamily } from "../evolution/candidate-pool.ts";
import { injectGrade, injectGrades, type InjectGradeRequest } from "../evolution/grade-inject.ts";
import { appendJudgement } from "../evolution/judgement-feed.ts";
import { runCandidateAuthor, CandidateCliError } from "../evolution/candidate-cli.ts";
import { buildScoreReport, readBaselineRate, readBaselineByCase, aggregateSkillDeltaFromCases, coverageGap, readDigestCaseScores, aggregateSkillDeltaByDigest, validateDigestPrefix, type BaselineReading, type BaselineByCase, type DigestSkillDelta, type DigestMergeStrategy } from "../evolution/score-report.ts";
import { auditConsistency, resolveDocsRsiDefault } from "../evolution/audit-consistency.ts";
import { assertCanonicalId, validateId, validateCaseId } from "../audit/id.ts";

export type RepoSkillsCommand =
	| { type: "help" }
	| { type: "install" | "update"; force: boolean }
	| { type: "status" }
	| { type: "router"; enabled: boolean }
	| { type: "usage" }
	| { type: "report"; json: boolean }
	| { type: "ledger"; json: boolean }
	| { type: "artifact"; runId: string; skillId?: string; caseId?: string }
	| { type: "audit"; json: boolean; benchmarkRoot: string; runId?: string; candidate?: string; source?: string; split?: readonly ("train" | "dev" | "heldout")[]; executor?: "proxy" | "agent"; skillId?: string; caseId?: string; skillRoot?: string; candidateManifestFile?: string; candidateRoot?: string; agentBaseUrl?: string; agentModel?: string; agentApiKeyEnv?: string }
	| {
			type: "evolve";
			json: boolean;
			roundId: string;
			targetSkillId: string;
			hypothesis: string;
			plan: string[];
			source: string;
			finding: string;
			empirical: boolean;
	  }
	| { type: "baseline"; json: boolean; benchmarkRoot: string; seed: string; grader: "token" | "structure"; split?: readonly ("train" | "dev" | "heldout")[] }
	| { type: "candidate"; skillId: string; skillRoot: string; patchFile: string; author: string; reason: string; stagingDir?: string; out?: string; json: boolean }
	| { type: "family"; json: boolean; benchmarkRoot: string; candidatesFile: string; split?: readonly ("train" | "dev" | "heldout")[] }
	| { type: "heldoutFinalEval"; json: boolean; benchmarkRoot: string; runId: string; candidate: string; source?: string }
	| { type: "pool"; json: boolean; family?: string }
	| { type: "grade"; runId?: string; skillId?: string; caseId?: string; score?: number; by: "human" | "model_grader"; note?: string; fromJson?: string; reviewerId?: string; rubricVersion?: string; evidenceRef?: string }
	| { type: "judgement"; runId: string; skillId: string; caseId: string; score: number; by: "human" | "assertion" | "model_grader"; reviewerId?: string; rubricVersion?: string; evidenceRef?: string }
	| { type: "evalreport"; json: boolean; run?: string; baseline?: string; candidate?: string; merge?: "mean" | "latest" }
	| { type: "auditConsistency"; json: boolean; docs?: string }
	| { type: "familyDisparity"; json: boolean; family?: string; baseline?: string; merge: DigestMergeStrategy };

interface RepoSkillsCommandManager {
	install(options?: { force?: boolean }): Promise<RepoSkillsInstallResult>;
	update(options?: { force?: boolean }): Promise<RepoSkillsInstallResult>;
	status(): RepoSkillsLibraryStatus;
	setRouterEnabled(enabled: boolean): Promise<RepoSkillsRouterToggleResult>;
}

export interface RepoSkillsCommandHandlerOptions {
	manager?: RepoSkillsCommandManager;
}

function usage(): string {
	return `${APP_NAME} repo-skills <install|update|status|router enable|router disable|usage|report|ledger|artifact|audit|evolve|baseline|candidate|family|pool|grade|judgement|evalreport|audit-consistency>`;
}

export function printRepoSkillsHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} repo-skills install [--force]
  ${APP_NAME} repo-skills update [--force]
  ${APP_NAME} repo-skills status
  ${APP_NAME} repo-skills router disable
  ${APP_NAME} repo-skills router enable
  ${APP_NAME} repo-skills usage
  ${APP_NAME} repo-skills report [--json]
  ${APP_NAME} repo-skills ledger [--json]
  ${APP_NAME} repo-skills artifact --run <id> [--skill <id>] [--case <id>]
  ${APP_NAME} repo-skills audit --benchmark <root> [--json] [--run <run-id>] [--split train|dev|heldout]
  ${APP_NAME} repo-skills audit --benchmark <root> --run <id> --executor agent --skill <id> --case <id> [--skill-root <repo-skills-dir>] [--candidate-manifest <file> --candidate-root <staged-skill-dir>]
  ${APP_NAME} repo-skills evolve --propose --round <id> --skill <id> --hypothesis "<h>" --plan "a|b" [--source <s>] [--finding "<f>"] [--empirical] [--json]
  ${APP_NAME} repo-skills baseline --benchmark <root> [--json] [--seed <s>] [--split train|dev|heldout]
  ${APP_NAME} repo-skills candidate author --skill <id> --skill-root <dir> --patch <json-file> --author <name> --reason "<why>" [--staging-dir <dir>] [--out <dir>] [--json]
  ${APP_NAME} repo-skills family --candidates <json-file> --benchmark <root> [--json] [--split train|dev|heldout]
  ${APP_NAME} repo-skills heldout-final-eval --run <id> --candidate <text> --benchmark <root> [--json] [--source <text>]
  ${APP_NAME} repo-skills family-disparity [--family <prefix>] [--baseline <run-id>] [--merge mean|latest] [--json]
  ${APP_NAME} repo-skills pool [--json] [--family <run-id-prefix>]
  ${APP_NAME} repo-skills grade --run <id> --skill <id> --case <case-id> --score <0..1> [--by human|model_grader] [--reviewer <id>] [--rubric <version>] [--evidence <ref>] [--note <text>]
  ${APP_NAME} repo-skills grade --from-json <grades-file> [--by human|model_grader]
  ${APP_NAME} repo-skills judgement --run <id> --skill <id> --case <case-id> --score <0..1> [--by human|assertion|model_grader] [--reviewer <id>] [--rubric <version>] [--evidence <ref>]
  ${APP_NAME} repo-skills evalreport [--json] [--run <id>] [--baseline <run-id>] [--candidate <digest>] [--merge mean|latest]
  ${APP_NAME} repo-skills audit-consistency [--json] [--docs <dir>]

Install and update the repository skill collection managed by ${APP_NAME}.

Commands:
  install          Install or adopt managed repo skills and build the router
  update           Update managed skills while preserving local Creator skills
  status           Show source commit, local drift, skill counts, and router state
  router disable   Stop automatic router selection; explicit /skill: invocation remains available
  router enable    Restore automatic router selection
  usage            Show runtime repository-skill usage metrics from observed events
  report           Show observer health and event drop/loss counters (--json for machine output)
  ledger           Project observed task judgements into the benchmark quality ledger (--json for JSONL rows)
  artifact         Review a persisted run's case artifact: print the stored artifact text for a run
                   (optionally filtered by --skill/--case) to stdout. Reads artifacts.jsonl only; a legacy
                   run with no artifacts.jsonl prints nothing rather than erroring.
  audit            Deterministic L0 preflight of the frozen benchmark: enumerate + validate all cases
                   and report the split/skill inventory (--json for machine output). RSI benchmarks are
                   dev-only assets (NOT shipped in the published package), so --benchmark <root> is
                   required and must point at a real benchmark manifest directory.
                   With --run <id>: execute the deterministic plumbing baseline and persist ledger.jsonl +
                   summary.json under the quality dir (results are plumbing, NOT a routing-quality claim).
                   With --run <id> --candidate "<text>" [--source "<s>"]: candidate-eval run-batch — score the
                   candidate with the deterministic model-grader proxy and persist kind=candidate-eval
                   (candidate sha256 recorded; proxy grader, NOT a routing-quality claim).
                   With --executor agent: run one train/dev case from a managed or --skill-root skill tree.
                   --candidate-manifest + --candidate-root bind that run to a verified staged skill patch;
                   the built-in driver is FAKE and the grader is a deterministic proxy until a real driver
                   and independent grader are supplied by a caller.
  evolve           PROPOSE-ONLY Step 4: generate an inert candidate proposal for a skill (hypothesis + plan
                   + evidence). NEVER modifies the live skill tree; no auto mode exists. Promotion is a
                   separate human-gated Step 5 action. --empirical only when the evidence is an observed
                   result (safe default: research note, not fact).
  baseline         Equal-budget baseline harness B0/B1/B2 (retry / random-edit / propose) over the frozen
                   benchmark with a deterministic grader. Results are harness demonstration, NOT a routing
                   quality result. Deterministic per seed. Dev-only: --benchmark <root> is required.
  family           Candidate-family regression: evaluate a batch of proposed candidates (from a JSON manifest)
                   on the same frozen benchmark with the deterministic model-grader proxy and aggregate by
                   genealogy. Ranking is a harness demonstration, NOT a routing-quality or causal claim.
                   Dev-only: --benchmark <root> is required.
  pool             List already-recorded candidate-eval runs from the quality dir (reads summary/ledger only;
                   no re-grading). --family <prefix> narrows to one family run-id prefix.
  grade            Inject a REAL human or downstream-model grade into a candidate-eval ledger row (rewrites
                   score/gradedBy/ts in the row and recomputes the run summary rate). Only applies to
                   candidate-eval runs; recorded traceably, never a re-run, no auto-promotion.
                   Use --from-json <file> to batch-inject many grades at once (array or {grades:[...]}).
  judgement       Append a production task_judgement row to the dedicated judgements ledger in the events
                   dir (read by the ledger command). This is the labelled source the observer never infers:
                   a human reviewer or benchmark harness explicitly records task success per skill.
                   Append-only, canonical-ID validated, never touches the observer's raw rotation files.
  evalreport       Cross-run score report over candidate-eval ledgers: per-run summary, per-case entries with
                   gradedBy/ts, per-candidate mean (with per-skill breakdown), plus structural issue detection
                   (score range, duplicate cases, row-count vs manifest, runId mismatch, mixed digests).
                   --baseline <run-id> shows Δ vs a recorded run's task_success_rate (numeric difference only),
                   per-case Δbase, and Skill Δbase (with --run or --candidate <hex digest prefix>, over overlapping
                   cases; --merge mean|latest controls how multi-run digest scores are combined).
                   Reads only; surfaces issues, never auto-fixes.
  audit-consistency Read-only runtime consistency audit: Step-4 no-live-apply, routing-honesty labels present,
                   ledger self-consistency, and doc archives present. Reports PASS/FAIL; never auto-fixes.

Options:
  --force          Back up and replace conflicting or locally modified official skills
  --json           Machine-readable JSON output for report / ledger / audit
  -h, --help       Show this help
`);
}

/**
 * BUG-P0-04: parse the --split allowlist. Values are one or more of
 * train|dev|heldout (a comma or pipe separation is accepted). An explicit
 * `--split heldout` is how an operator requests the independent, post-freeze
 * held-out terminal eval; candidate ranking stays train+dev by default.
 */
function parseSplitFlag(value: string): Array<"train" | "dev" | "heldout"> {
	const allowed = new Set(["train", "dev", "heldout"]);
	const parts = value.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
	if (parts.length === 0) throw new RepoSkillsLibraryError("--split requires at least one of train|dev|heldout.", 2);
	for (const p of parts) {
		if (!allowed.has(p)) throw new RepoSkillsLibraryError(`--split must be train|dev|heldout (got "${p}").`, 2);
	}
	const out = [...new Set(parts)] as Array<"train" | "dev" | "heldout">;
	// Stable order: train, dev, heldout.
	return out.sort((a, b) => ["train", "dev", "heldout"].indexOf(a) - ["train", "dev", "heldout"].indexOf(b));
}

export function parseRepoSkillsCommand(args: string[]): RepoSkillsCommand | undefined {
	const normalizedArgs = args.filter((arg) => arg !== "--offline");	if (normalizedArgs[0] !== "repo-skills") return undefined;
	const rest = normalizedArgs.slice(1);
	if (rest.length === 0 || rest[0] === "-h" || rest[0] === "--help") return { type: "help" };
	const command = rest[0];
	if (command === "install" || command === "update") {
		let force = false;
		for (const arg of rest.slice(1)) {
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--force") {
				force = true;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for ${command}: ${arg}\nUsage: ${usage()}`, 2);
		}
		return { type: command, force };
	}
	if (command === "status") {
		if (rest.length > 1) {
			if (rest[1] === "-h" || rest[1] === "--help") return { type: "help" };
			throw new RepoSkillsLibraryError(`Unexpected argument for status: ${rest[1]}\nUsage: ${usage()}`, 2);
		}
		return { type: "status" };
	}
	if (command === "router") {
		if (rest[1] === "-h" || rest[1] === "--help") return { type: "help" };
		if (rest.length !== 2 || (rest[1] !== "enable" && rest[1] !== "disable")) {
			throw new RepoSkillsLibraryError(`Router command must be "enable" or "disable".\nUsage: ${usage()}`, 2);
		}
		return { type: "router", enabled: rest[1] === "enable" };
	}
	if (command === "usage") {
		if (rest.length > 1) {
			if (rest[1] === "-h" || rest[1] === "--help") return { type: "help" };
			throw new RepoSkillsLibraryError(`Unexpected argument for usage: ${rest[1]}\nUsage: ${usage()}`, 2);
		}
		return { type: "usage" };
	}
	if (command === "report") {
		let json = false;
		for (const arg of rest.slice(1)) {
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for report: ${arg}\nUsage: ${usage()}`, 2);
		}
		return { type: "report", json };
	}
	if (command === "ledger") {
		let json = false;
		for (const arg of rest.slice(1)) {
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for ledger: ${arg}\nUsage: ${usage()}`, 2);
		}
		return { type: "ledger", json };
	}
	if (command === "artifact") {
		// repo-skills artifact --run <id> [--skill <id>] [--case <id>]
		let runId: string | undefined;
		let skillId: string | undefined;
		let caseId: string | undefined;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--run") {
				runId = args[i + 1];
				if (runId === undefined) throw new RepoSkillsLibraryError("artifact: --run requires a run-id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--skill") {
				skillId = args[i + 1];
				if (skillId === undefined) throw new RepoSkillsLibraryError("artifact: --skill requires a skill id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--case") {
				caseId = args[i + 1];
				if (caseId === undefined) throw new RepoSkillsLibraryError("artifact: --case requires a case id.", 2);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for artifact: ${arg}\nUsage: ${usage()}`, 2);
		}
		if (runId === undefined) throw new RepoSkillsLibraryError("artifact requires --run <run-id>.", 2);
		// BUG-P0-02: canonical id validation at parse time.
		const aErr = validateId(runId, "runId") ?? (skillId !== undefined ? validateId(skillId, "skillId") : null) ?? (caseId !== undefined ? validateCaseId(caseId) : null);
		if (aErr !== null) throw new RepoSkillsLibraryError(`artifact: ${aErr}.`, 2);
		return { type: "artifact", runId, skillId, caseId };
	}
	if (command === "audit") {
		let json = false;
		let runId: string | undefined;
		let candidate: string | undefined;
		let source: string | undefined;
		let benchmarkRoot: string | undefined;
		let split: readonly ("train" | "dev" | "heldout")[] | undefined;
		let executor: "proxy" | "agent" | undefined;
		let skillId: string | undefined;
		let caseId: string | undefined;
		let skillRoot: string | undefined;
		let candidateManifestFile: string | undefined;
		let candidateRoot: string | undefined;
		let agentBaseUrl: string | undefined;
		let agentModel: string | undefined;
		let agentApiKeyEnv: string | undefined;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--executor") {
				const v = args[i + 1];
				if (v === "proxy" || v === "agent") {
					executor = v;
					i += 1;
					continue;
				}
				throw new RepoSkillsLibraryError("--executor must be 'proxy' or 'agent'.", 2);
			}
			if (arg === "--skill") {
				skillId = args[i + 1];
				if (skillId === undefined) throw new RepoSkillsLibraryError("--skill requires a skill id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--case") {
				caseId = args[i + 1];
				if (caseId === undefined) throw new RepoSkillsLibraryError("--case requires a case id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--skill-root") {
				skillRoot = args[i + 1];
				if (skillRoot === undefined) throw new RepoSkillsLibraryError("--skill-root requires a directory path.", 2);
				i += 1;
				continue;
			}
			if (arg === "--candidate-manifest") {
				candidateManifestFile = args[i + 1];
				if (candidateManifestFile === undefined) throw new RepoSkillsLibraryError("--candidate-manifest requires a JSON file path.", 2);
				i += 1;
				continue;
			}
			if (arg === "--candidate-root") {
				candidateRoot = args[i + 1];
				if (candidateRoot === undefined) throw new RepoSkillsLibraryError("--candidate-root requires a staged skill directory.", 2);
				i += 1;
				continue;
			}
			if (arg === "--run") {
				runId = args[i + 1];
				if (runId === undefined) throw new RepoSkillsLibraryError("--run requires a run-id argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--candidate") {
				candidate = args[i + 1];
				if (candidate === undefined) throw new RepoSkillsLibraryError("--candidate requires a text argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--source") {
				source = args[i + 1];
				if (source === undefined) throw new RepoSkillsLibraryError("--source requires a text argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--benchmark") {
				benchmarkRoot = args[i + 1];
				if (benchmarkRoot === undefined) throw new RepoSkillsLibraryError("--benchmark requires a path argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--split") {
				const v = args[i + 1];
				if (v === undefined) throw new RepoSkillsLibraryError("--split requires a value (train|dev|heldout).", 2);
				split = parseSplitFlag(v);
				i += 1;
				continue;
			}
			if (arg === "--agent-base-url") {
				agentBaseUrl = args[i + 1];
				if (agentBaseUrl === undefined) throw new RepoSkillsLibraryError("--agent-base-url requires a URL.", 2);
				i += 1;
				continue;
			}
			if (arg === "--agent-model") {
				agentModel = args[i + 1];
				if (agentModel === undefined) throw new RepoSkillsLibraryError("--agent-model requires a model id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--agent-api-key-env") {
				agentApiKeyEnv = args[i + 1];
				if (agentApiKeyEnv === undefined) throw new RepoSkillsLibraryError("--agent-api-key-env requires an env var name.", 2);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for audit: ${arg}\nUsage: ${usage()}`, 2);
		}
		if (runId !== undefined) {
			const idErr = validateId(runId, "runId");
			if (idErr !== null) throw new RepoSkillsLibraryError(`audit: ${idErr}.`, 2);
		}
		// BUG-P2-15: don't silently ignore --candidate/--source. They are only
		// meaningful on the candidate-eval run-batch path, which requires --run.
		if (candidate !== undefined && runId === undefined) {
			throw new RepoSkillsLibraryError(
				"audit: --candidate requires --run (candidate evaluation is a run-batch); --candidate without --run would be silently dropped.",
				2,
			);
		}
		if (source !== undefined && runId === undefined) {
			throw new RepoSkillsLibraryError(
				"audit: --source requires --run (it labels a candidate-eval run-batch); --source without --run would be silently dropped.",
				2,
			);
		}
		if (source !== undefined && candidate === undefined) {
			throw new RepoSkillsLibraryError(
				"audit: --source requires --candidate (it records where a candidate came from, so a candidate text is required).",
				2,
			);
		}
		// BUG-P0-03: the RSI benchmark is a source-of-truth dev asset, not shipped
		// in the published npm package, so the default must NOT point at a runtime
		// dir that never exists. `audit` is a developer command: --benchmark is
		// required, and the caller must point at an actual benchmark manifest.
		if (benchmarkRoot === undefined) {
			throw new RepoSkillsLibraryError(
				`audit: --benchmark <root> is required (RSI benchmarks are dev-only assets; the published package has no default).\nUsage: ${usage()}`,
				2,
			);
		}
		// B2: the `--executor agent` path is a distinct single-case real-execution
		// run, so it must name exactly one skill+case and a run id; it must not be
		// combined with the proxy candidate path.
		if (executor === "agent") {
			if (runId === undefined) throw new RepoSkillsLibraryError("audit: --executor agent requires --run <run-id>.", 2);
			if (candidate !== undefined) throw new RepoSkillsLibraryError("audit: --executor agent cannot be combined with --candidate.", 2);
			if (split !== undefined) throw new RepoSkillsLibraryError("audit: --split is not supported with --executor agent; the single-case agent path is restricted to train/dev.", 2);
			if (skillId === undefined || caseId === undefined) throw new RepoSkillsLibraryError("audit: --executor agent requires --skill <id> and --case <case-id> (single case).", 2);
			const aErr = validateId(skillId, "skillId") ?? validateCaseId(caseId);
			if (aErr !== null) throw new RepoSkillsLibraryError(`audit: ${aErr}.`, 2);
		}
		if ((candidateManifestFile === undefined) !== (candidateRoot === undefined)) {
			throw new RepoSkillsLibraryError("audit: --candidate-manifest and --candidate-root must be supplied together.", 2);
		}
		if (executor !== "agent" && (skillId !== undefined || caseId !== undefined || skillRoot !== undefined || candidateManifestFile !== undefined)) {
			throw new RepoSkillsLibraryError("audit: --skill/--case/--skill-root/--candidate-manifest require --executor agent.", 2);
		}
		return { type: "audit", json, benchmarkRoot, runId, candidate, source, split, executor, skillId, caseId, skillRoot, candidateManifestFile, candidateRoot, agentBaseUrl, agentModel, agentApiKeyEnv };
	}
	if (command === "evolve") {
		// Propose-only: only `--propose` exists; there is intentionally NO auto mode.
		let roundId: string | undefined;
		let targetSkillId: string | undefined;
		let hypothesis: string | undefined;
		const plan: string[] = [];
		let source = "quality-ledger";
		let finding = "";
		let empirical = false;
		let json = false;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--propose") {
				// Marker that this is propose-only mode (the only mode that exists).
				continue;
			}
			if (arg === "--round") {
				roundId = args[i + 1];
				if (roundId === undefined) throw new RepoSkillsLibraryError("--round requires a round-id argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--skill") {
				targetSkillId = args[i + 1];
				if (targetSkillId === undefined) throw new RepoSkillsLibraryError("--skill requires a skill-id argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--hypothesis") {
				hypothesis = args[i + 1];
				if (hypothesis === undefined) throw new RepoSkillsLibraryError("--hypothesis requires a value argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--plan") {
				const v = args[i + 1];
				if (v === undefined) throw new RepoSkillsLibraryError("--plan requires a value argument (pipe-separated).", 2);
				for (const item of v.split("|")) if (item.trim()) plan.push(item.trim());
				i += 1;
				continue;
			}
			if (arg === "--source") {
				const v = args[i + 1];
				if (v === undefined) throw new RepoSkillsLibraryError("--source requires a value argument.", 2);
				source = v;
				i += 1;
				continue;
			}
			if (arg === "--finding") {
				const v = args[i + 1];
				if (v === undefined) throw new RepoSkillsLibraryError("--finding requires a value argument.", 2);
				finding = v;
				i += 1;
				continue;
			}
			if (arg === "--empirical") {
				empirical = true;
				continue;
			}
			if (arg === "auto" || arg === "--auto" || arg === "--mode" || arg === "--mode auto") {
				throw new RepoSkillsLibraryError("--mode auto is intentionally not available: evolution is propose-only (no unattended promotion).", 2);
			}
			throw new RepoSkillsLibraryError(`Unknown option for evolve: ${arg}\nUsage: ${usage()}`, 2);
		}
		if (roundId === undefined || targetSkillId === undefined || hypothesis === undefined || plan.length === 0) {
			throw new RepoSkillsLibraryError("evolve --propose requires --round, --skill, --hypothesis, and at least one --plan item.", 2);
		}
		return { type: "evolve", json, roundId, targetSkillId, hypothesis, plan, source, finding, empirical };
	}
	if (command === "baseline") {
		let json = false;
		let seed = "seed-default";
		let grader: "token" | "structure" = "token";
		let benchmarkRoot: string | undefined;
		let split: readonly ("train" | "dev" | "heldout")[] | undefined;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--seed") {
				const v = args[i + 1];
				if (v === undefined) throw new RepoSkillsLibraryError("--seed requires a value argument.", 2);
				seed = v;
				i += 1;
				continue;
			}
			if (arg === "--grader") {
				const v = args[i + 1];
				if (v === "structure" || v === "token") {
					grader = v;
					i += 1;
					continue;
				}
				throw new RepoSkillsLibraryError("--grader must be 'token' or 'structure'.", 2);
			}
			if (arg === "--benchmark") {
				benchmarkRoot = args[i + 1];
				if (benchmarkRoot === undefined) throw new RepoSkillsLibraryError("--benchmark requires a path argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--split") {
				const v = args[i + 1];
				if (v === undefined) throw new RepoSkillsLibraryError("--split requires a value (train|dev|heldout).", 2);
				split = parseSplitFlag(v);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for baseline: ${arg}\nUsage: ${usage()}`, 2);
		}
		// BUG-P0-03: baseline is a developer-only harness command; the benchmark
		// is not shipped in the published package, so --benchmark is required.
		if (benchmarkRoot === undefined) {
			throw new RepoSkillsLibraryError(
				`baseline: --benchmark <root> is required (RSI benchmarks are dev-only assets; the published package has no default).\nUsage: ${usage()}`,
				2,
			);
		}
		return { type: "baseline", json, benchmarkRoot, seed, grader, split };
	}
	if (command === "candidate") {
		// repo-skills candidate author --skill <id> --skill-root <dir> --patch <json> --author <name> --reason "<why>" [--staging-dir <dir>] [--out <dir>] [--json]
		let skillId: string | undefined;
		let skillRoot: string | undefined;
		let patchFile: string | undefined;
		let author: string | undefined;
		let reason: string | undefined;
		let stagingDir: string | undefined;
		let out: string | undefined;
		let json = false;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "author") continue; // sub-mode marker (only "author" exists)
			if (arg === "--skill") {
				skillId = args[i + 1];
				if (skillId === undefined) throw new RepoSkillsLibraryError("candidate --skill requires an argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--skill-root") {
				skillRoot = args[i + 1];
				if (skillRoot === undefined) throw new RepoSkillsLibraryError("candidate --skill-root requires an argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--patch") {
				patchFile = args[i + 1];
				if (patchFile === undefined) throw new RepoSkillsLibraryError("candidate --patch requires an argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--author") {
				author = args[i + 1];
				if (author === undefined) throw new RepoSkillsLibraryError("candidate --author requires an argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--reason") {
				reason = args[i + 1];
				if (reason === undefined) throw new RepoSkillsLibraryError("candidate --reason requires an argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--staging-dir") {
				stagingDir = args[i + 1];
				if (stagingDir === undefined) throw new RepoSkillsLibraryError("candidate --staging-dir requires an argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--out") {
				out = args[i + 1];
				if (out === undefined) throw new RepoSkillsLibraryError("candidate --out requires an argument.", 2);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for candidate: ${arg}\nUsage: ${usage()}`, 2);
		}
		if (!skillId || !skillRoot || !patchFile || !author || !reason) {
			throw new RepoSkillsLibraryError("candidate author requires --skill, --skill-root, --patch, --author, and --reason.", 2);
		}
		return { type: "candidate", json, skillId, skillRoot, patchFile, author, reason, stagingDir, out };
	}
	if (command === "family") {
		let json = false;
		let candidatesFile: string | undefined;
		let benchmarkRoot: string | undefined;
		let split: readonly ("train" | "dev" | "heldout")[] | undefined;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--candidates") {
				candidatesFile = args[i + 1];
				if (candidatesFile === undefined) throw new RepoSkillsLibraryError("--candidates requires a JSON file path.", 2);
				i += 1;
				continue;
			}
			if (arg === "--benchmark") {
				benchmarkRoot = args[i + 1];
				if (benchmarkRoot === undefined) throw new RepoSkillsLibraryError("--benchmark requires a path argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--split") {
				const v = args[i + 1];
				if (v === undefined) throw new RepoSkillsLibraryError("--split requires a value (train|dev|heldout).", 2);
				split = parseSplitFlag(v);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for family: ${arg}\nUsage: ${usage()}`, 2);
		}
		if (candidatesFile === undefined) throw new RepoSkillsLibraryError("family requires --candidates <file>.", 2);
		// BUG-P0-03: family is a developer-only command; the benchmark is not
		// shipped in the published package, so --benchmark is required.
		if (benchmarkRoot === undefined) {
			throw new RepoSkillsLibraryError(
				`family: --benchmark <root> is required (RSI benchmarks are dev-only assets; the published package has no default).\nUsage: ${usage()}`,
				2,
			);
		}
		return { type: "family", json, benchmarkRoot, candidatesFile, split };
	}
	if (command === "heldout-final-eval") {
		// P1-4: the ONLY sanctioned path that loads the held-out terminal set.
		let json = false;
		let runId: string | undefined;
		let candidate: string | undefined;
		let source: string | undefined;
		let benchmarkRoot: string | undefined;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--run") {
				runId = args[i + 1];
				if (runId === undefined) throw new RepoSkillsLibraryError("--run requires a run-id argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--candidate") {
				candidate = args[i + 1];
				if (candidate === undefined) throw new RepoSkillsLibraryError("--candidate requires a text argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--source") {
				source = args[i + 1];
				if (source === undefined) throw new RepoSkillsLibraryError("--source requires a text argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--benchmark") {
				benchmarkRoot = args[i + 1];
				if (benchmarkRoot === undefined) throw new RepoSkillsLibraryError("--benchmark requires a path argument.", 2);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for heldout-final-eval: ${arg}\nUsage: ${usage()}`, 2);
		}
		if (runId === undefined) throw new RepoSkillsLibraryError("heldout-final-eval requires --run <run-id>.", 2);
		if (candidate === undefined) throw new RepoSkillsLibraryError("heldout-final-eval requires --candidate <text>.", 2);
		const idErr = validateId(runId, "runId");
		if (idErr !== null) throw new RepoSkillsLibraryError(`heldout-final-eval: ${idErr}.`, 2);
		if (benchmarkRoot === undefined) {
			throw new RepoSkillsLibraryError(
				`heldout-final-eval: --benchmark <root> is required (RSI benchmarks are dev-only assets; the published package has no default).\nUsage: ${usage()}`,
				2,
			);
		}
		return { type: "heldoutFinalEval", json, benchmarkRoot, runId, candidate, source };
	}
	if (command === "pool") {
		let json = false;
		let family: string | undefined;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--family") {
				family = args[i + 1];
				if (family === undefined) throw new RepoSkillsLibraryError("--family requires a run-id prefix.", 2);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for pool: ${arg}\nUsage: ${usage()}`, 2);
		}
		return { type: "pool", json, family };
	}
	if (command === "grade") {
		let runId: string | undefined;
		let skillId: string | undefined;
		let caseId: string | undefined;
		let score: number | undefined;
		let by: "human" | "model_grader" = "human";
		let note: string | undefined;
		let fromJson: string | undefined;
		let reviewerId: string | undefined;
		let rubricVersion: string | undefined;
		let evidenceRef: string | undefined;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--from-json") {
				fromJson = args[i + 1];
				if (fromJson === undefined) throw new RepoSkillsLibraryError("--from-json requires a JSON file path.", 2);
				i += 1;
				continue;
			}
			if (arg === "--run") {
				runId = args[i + 1];
				if (runId === undefined) throw new RepoSkillsLibraryError("--run requires a run-id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--skill") {
				skillId = args[i + 1];
				if (skillId === undefined) throw new RepoSkillsLibraryError("--skill requires a skill id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--case") {
				caseId = args[i + 1];
				if (caseId === undefined) throw new RepoSkillsLibraryError("--case requires a case id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--score") {
				score = Number(args[i + 1]);
				if (!Number.isFinite(score)) throw new RepoSkillsLibraryError("--score requires a number in [0,1].", 2);
				i += 1;
				continue;
			}
			if (arg === "--by") {
				const v = args[i + 1];
				if (v === "human" || v === "model_grader") by = v;
				else throw new RepoSkillsLibraryError("--by must be 'human' or 'model_grader'.", 2);
				i += 1;
				continue;
			}
			if (arg === "--note") {
				note = args[i + 1];
				if (note === undefined) throw new RepoSkillsLibraryError("--note requires a text argument.", 2);
				i += 1;
				continue;
			}
			if (arg === "--reviewer") {
				reviewerId = args[i + 1];
				if (reviewerId === undefined) throw new RepoSkillsLibraryError("--reviewer requires a reviewer id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--rubric") {
				rubricVersion = args[i + 1];
				if (rubricVersion === undefined) throw new RepoSkillsLibraryError("--rubric requires a version.", 2);
				i += 1;
				continue;
			}
			if (arg === "--evidence") {
				evidenceRef = args[i + 1];
				if (evidenceRef === undefined) throw new RepoSkillsLibraryError("--evidence requires a ref.", 2);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for grade: ${arg}\nUsage: ${usage()}`, 2);
		}
		if (fromJson !== undefined) {
			if (runId !== undefined || skillId !== undefined || caseId !== undefined || score !== undefined) {
				throw new RepoSkillsLibraryError("grade: --from-json cannot be combined with --run/--skill/--case/--score.", 2);
			}
			return { type: "grade", by, fromJson, reviewerId, rubricVersion, evidenceRef };
		}
		if (runId === undefined || skillId === undefined || caseId === undefined || score === undefined) {
			throw new RepoSkillsLibraryError("grade requires --run, --skill, --case, and --score.", 2);
		}
		// BUG-P0-02: reject non-canonical ids at parse time.
		const gErr =
			validateId(runId, "runId") ?? validateId(skillId, "skillId") ?? validateCaseId(caseId);
		if (gErr !== null) throw new RepoSkillsLibraryError(`grade: ${gErr}.`, 2);
		// B3 (P0-3): a human grade must carry an authenticated reviewer + evidence,
		// CONSISTENT with the `judgement` command. Reject at parse time.
		if (by === "human" && (!reviewerId || !reviewerId.trim())) {
			throw new RepoSkillsLibraryError("grade: human grade requires --reviewer (and --evidence).", 2);
		}
		if (by === "human" && (!evidenceRef || !evidenceRef.trim())) {
			throw new RepoSkillsLibraryError("grade: human grade requires --evidence.", 2);
		}
		return { type: "grade", runId, skillId, caseId, score, by, note, reviewerId, rubricVersion, evidenceRef };
	}
	if (command === "judgement") {
		let runId: string | undefined;
		let skillId: string | undefined;
		let caseId: string | undefined;
		let score: number | undefined;
		let by: "human" | "assertion" | "model_grader" = "human";
		let reviewerId: string | undefined;
		let rubricVersion: string | undefined;
		let evidenceRef: string | undefined;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--run") {
				runId = args[i + 1];
				if (runId === undefined) throw new RepoSkillsLibraryError("--run requires a run id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--skill") {
				skillId = args[i + 1];
				if (skillId === undefined) throw new RepoSkillsLibraryError("--skill requires a skill id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--case") {
				caseId = args[i + 1];
				if (caseId === undefined) throw new RepoSkillsLibraryError("--case requires a case id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--score") {
				score = Number(args[i + 1]);
				if (!Number.isFinite(score)) throw new RepoSkillsLibraryError("--score requires a number in [0,1].", 2);
				i += 1;
				continue;
			}
			if (arg === "--by") {
				const v = args[i + 1];
				if (v === "human" || v === "assertion" || v === "model_grader") by = v;
				else throw new RepoSkillsLibraryError("--by must be 'human', 'assertion', or 'model_grader'.", 2);
				i += 1;
				continue;
			}
			if (arg === "--reviewer") {
				reviewerId = args[i + 1];
				if (reviewerId === undefined) throw new RepoSkillsLibraryError("--reviewer requires an id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--rubric") {
				rubricVersion = args[i + 1];
				if (rubricVersion === undefined) throw new RepoSkillsLibraryError("--rubric requires a version.", 2);
				i += 1;
				continue;
			}
			if (arg === "--evidence") {
				evidenceRef = args[i + 1];
				if (evidenceRef === undefined) throw new RepoSkillsLibraryError("--evidence requires a ref.", 2);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for judgement: ${arg}\nUsage: ${usage()}`, 2);
		}
		if (runId === undefined || skillId === undefined || caseId === undefined || score === undefined) {
			throw new RepoSkillsLibraryError("judgement requires --run, --skill, --case, and --score.", 2);
		}
		const jErr = validateId(runId, "runId") ?? validateId(skillId, "skillId") ?? validateCaseId(caseId);
		if (jErr !== null) throw new RepoSkillsLibraryError(`judgement: ${jErr}.`, 2);
		if (by === "human" && (!reviewerId || !reviewerId.trim())) throw new RepoSkillsLibraryError("judgement: --reviewer is required for a human grade.", 2);
		// B3 (P0-3): a human judgement also requires an evidence ref, consistent
		// with the `grade` command and `appendJudgement`.
		if (by === "human" && (!evidenceRef || !evidenceRef.trim())) throw new RepoSkillsLibraryError("judgement: --evidence is required for a human grade.", 2);
		return { type: "judgement", runId, skillId, caseId, score, by, reviewerId, rubricVersion, evidenceRef };
	}
	if (command === "evalreport") {
		let json = false;
		let run: string | undefined;
		let baseline: string | undefined;
		let candidate: string | undefined;
		let merge: "mean" | "latest" = "mean";
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--run") {
				run = args[i + 1];
				if (run === undefined) throw new RepoSkillsLibraryError("--run requires a run-id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--baseline") {
				baseline = args[i + 1];
				if (baseline === undefined) throw new RepoSkillsLibraryError("--baseline requires a run-id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--candidate") {
				candidate = args[i + 1];
				if (candidate === undefined) throw new RepoSkillsLibraryError("--candidate requires a candidate digest (≥8 hex chars).", 2);
				i += 1;
				continue;
			}
			if (arg === "--merge") {
				const v = args[i + 1];
				if (v === "mean" || v === "latest") merge = v;
				else throw new RepoSkillsLibraryError("--merge must be 'mean' or 'latest'.", 2);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for evalreport: ${arg}\nUsage: ${usage()}`, 2);
		}
		if (candidate !== undefined && run !== undefined) {
			throw new RepoSkillsLibraryError("evalreport: --candidate and --run are mutually exclusive.", 2);
		}
		if (candidate !== undefined && validateDigestPrefix(candidate) !== null) {
			throw new RepoSkillsLibraryError(`evalreport: ${validateDigestPrefix(candidate)}.`, 2);
		}
		// BUG-P0-02: run/baseline ids must be canonical.
		const eErr = (run !== undefined ? validateId(run, "run") : null) ?? (baseline !== undefined ? validateId(baseline, "baseline") : null);
		if (eErr !== null) throw new RepoSkillsLibraryError(`evalreport: ${eErr}.`, 2);
		return { type: "evalreport", json, run, baseline, candidate, merge };
	}
	if (command === "audit-consistency") {
		let json = false;
		let docs: string | undefined;
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--docs") {
				docs = args[i + 1];
				if (docs === undefined) throw new RepoSkillsLibraryError("--docs requires a directory path.", 2);
				i += 1;
				continue;
			}
			throw new RepoSkillsLibraryError(`Unknown option for audit-consistency: ${arg}\nUsage: ${usage()}`, 2);
		}
		return { type: "auditConsistency", json, docs };
	}
	if (command === "family-disparity") {
		let json = false;
		let family: string | undefined;
		let baseline: string | undefined;
		let merge: DigestMergeStrategy = "mean";
		const args = rest.slice(1);
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "-h" || arg === "--help") return { type: "help" };
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--family") {
				family = args[i + 1];
				if (family === undefined) throw new RepoSkillsLibraryError("--family requires a run-id prefix.", 2);
				i += 1;
				continue;
			}
			if (arg === "--baseline") {
				baseline = args[i + 1];
				if (baseline === undefined) throw new RepoSkillsLibraryError("--baseline requires a run-id.", 2);
				i += 1;
				continue;
			}
			if (arg === "--merge") {
				const v = args[i + 1];
				if (v === "mean" || v === "latest") {
					merge = v;
					i += 1;
					continue;
				}
				throw new RepoSkillsLibraryError("--merge must be 'mean' or 'latest'.", 2);
			}
			throw new RepoSkillsLibraryError(`Unknown option for family-disparity: ${arg}\nUsage: ${usage()}`, 2);
		}
		return { type: "familyDisparity", json, family, baseline, merge };
	}
	throw new RepoSkillsLibraryError(`Unknown repo-skills command: ${command}\nUsage: ${usage()}`, 2);
}

function printInstallResult(result: RepoSkillsInstallResult): void {
	if (result.noop) {
		console.log(
			result.operation === "install"
				? `Repository skills are already managed. Run \`${APP_NAME} repo-skills update\` to check for updates.`
				: "Repository skills are already up to date.",
		);
	} else {
		console.log(
			`${result.operation === "install" ? "Installed" : "Updated"} repository skills${result.commit ? ` from commit ${result.commit}` : ""}.`,
		);
	}
	console.log(`Official skills: ${result.managedSkills}`);
	console.log(`Local skills preserved: ${result.localSkills}`);
	console.log(`Total repo skills: ${result.totalSkills}`);
	if (result.repositoryCount !== undefined) console.log(`Routed repositories: ${result.repositoryCount}`);
	if (result.assignmentCount !== undefined) console.log(`Area-family assignments: ${result.assignmentCount}`);
	if (result.areaCount !== undefined && result.familyCount !== undefined) {
		console.log(`Router taxonomy: ${result.areaCount} areas, ${result.familyCount} families`);
	}
	if (result.routerEnabled !== undefined) {
		console.log(`Router: ${result.routerEnabled ? "enabled" : "disabled"}`);
	}
	if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
	for (const issue of result.issues) console.error(chalk.yellow(`Warning: ${issue}`));
	console.log("Start a new Researcher session to load the updated repository skill index.");
}

function printStatus(status: RepoSkillsLibraryStatus): void {
	console.log(`Installed: ${status.installed ? "yes" : "no"}`);
	console.log(`Managed by ${APP_NAME}: ${status.managed ? "yes" : "no"}`);
	if (status.sourceRepository) console.log(`Source: ${status.sourceRepository}`);
	if (status.commit) console.log(`Commit: ${status.commit} (${status.commit.slice(0, 12)})`);
	if (status.installedAt) console.log(`Installed at: ${status.installedAt}`);
	if (status.updatedAt) console.log(`Updated at: ${status.updatedAt}`);
	console.log(`Official skills: ${status.managedSkills}`);
	console.log(`Local skills: ${status.localSkills}`);
	console.log(`Total repo skills: ${status.totalSkills}`);
	if (status.repositoryCount !== undefined) console.log(`Routed repositories: ${status.repositoryCount}`);
	if (status.assignmentCount !== undefined) console.log(`Area-family assignments: ${status.assignmentCount}`);
	if (status.areaCount !== undefined && status.familyCount !== undefined) {
		console.log(`Router taxonomy: ${status.areaCount} areas, ${status.familyCount} families`);
	}
	console.log(`Files: ${status.totalFiles}`);
	console.log(
		`Router: ${status.routerPresent ? (status.routerEnabled ? "enabled" : "disabled") : "not installed"}`,
	);
	if (status.issues.length === 0) console.log("Drift: none");
	else {
		console.log("Drift/issues:");
		for (const issue of status.issues) console.log(`- ${issue}`);
	}
}

function printRouterResult(result: RepoSkillsRouterToggleResult): void {
	if (result.enabled) {
		console.log(result.changed ? "Enabled repo-skills-router automatic selection." : "Repo-skills-router is already enabled.");
	} else {
		console.log(
			result.changed
				? "Disabled repo-skills-router automatic selection. Explicit /skill:repo-skills-router invocation remains available."
				: "Repo-skills-router automatic selection is already disabled. Explicit /skill:repo-skills-router invocation remains available.",
		);
	}
	console.log("Start a new Researcher session for the change to take effect.");
}

function printUsage(eventsDir: string): void {
	const report = buildUsageReport(eventsDir);
	const m = report.metrics;
	console.log(`Observed events: ${report.eventCount}`);
	console.log(`Distinct skills: ${m.distinctSkills} / rows touching a skill: ${m.skillRowCount}`);
	console.log(`Router follow-through: ${m.routerFollowthroughRate === null ? "n/a" : (m.routerFollowthroughRate * 100).toFixed(1) + "%"} (${m.routerFollowthroughSessions}/${m.routerReadSessions} sessions)`);
	console.log(`Skill use rate: ${(m.skillUseRate * 100).toFixed(1)}% (${m.skillsUsed}/${m.distinctSkills})`);
	console.log(`Script calls: ${m.scriptCallCount} (failure rate ${(m.scriptFailureRate * 100).toFixed(1)}%)`);
	const statuses = Object.entries(m.runSettledByStatus)
		.map(([k, v]) => `${k}=${v}`)
		.join(", ");
	console.log(`Run settled: ${statuses || "(none)"}`);
	console.log(`Task success rate: ${m.taskSuccessRate === null ? "n/a (no judgements yet)" : (m.taskSuccessRate * 100).toFixed(1) + "%"}`);
	console.log(`Events dir: ${report.eventsDir}`);
}

function printReport(eventsDir: string, healthPath: string, json: boolean): void {
	const report = buildUsageReport(eventsDir);
	const h = report.health;
	if (json) {
		console.log(JSON.stringify({ events: report.metrics, health: h, currentMalformed: report.currentMalformed, eventCount: report.eventCount }, null, 2));
		return;
	}
	console.log(`Events dir: ${report.eventsDir}`);
	console.log(`Event count: ${report.eventCount}`);
	console.log(`Total events accepted: ${h.totalEvents}`);
	console.log(`Dropped events (write failures): ${h.droppedEvents}`);
	console.log(`Malformed lines (lifetime): ${h.malformedLines}`);
	console.log(`Malformed lines (current scan): ${report.currentMalformed}`);
	console.log(`Last write: ${h.lastWriteMs ? new Date(h.lastWriteMs).toISOString() : "never"}`);
	console.log(`Health snapshot: ${healthPath}`);
	if (h.droppedEvents > 0) {
		console.error(chalk.yellow(`Warning: ${h.droppedEvents} event(s) were dropped due to write failures.`));
		process.exitCode = 1;
	}
}

function printLedger(eventsDir: string, json: boolean): void {
	const { events } = readAllEvents(eventsDir);
	const rows = observerJudgementsToLedger(events);
	if (json) {
		for (const row of rows) console.log(JSON.stringify(row));
		return;
	}
	const rate = ledgerTaskSuccessRate(rows);
	console.log(`Quality ledger rows: ${rows.length}`);
	console.log(`Task success rate: ${rate === null ? "n/a (no graded observations yet)" : (rate * 100).toFixed(1) + "%"}`);
	const bySkill = new Map<string, number>();
	for (const row of rows) {
		bySkill.set(row.skillId, (bySkill.get(row.skillId) ?? 0) + 1);
	}
	for (const [skill, count] of [...bySkill.entries()].sort()) {
		console.log(`  ${skill}: ${count} observation(s)`);
	}
	console.log(`Events dir: ${eventsDir}`);
}

/**
 * P0-1 review entry: print the stored artifact text for a persisted run to
 * stdout, optionally filtered by --skill / --case. Reads only artifacts.jsonl;
 * a legacy run directory without that file yields no output rather than
 * erroring (backward compatible). A run should contain at most one row per
 * (skill, case); when both filters are given exactly one row is expected, and
 * the artifact is printed verbatim so it can be piped/reviewed.
 */
function printArtifact(cmd: Extract<RepoSkillsCommand, { type: "artifact" }>, qualityDir: string): void {
	let rows: ArtifactRow[];
	try {
		const dir = resolveAuditRunDir(qualityDir, cmd.runId);
		rows = readArtifacts(dir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return;
	}
	if (cmd.skillId !== undefined) rows = rows.filter((r) => r.skillId === cmd.skillId);
	if (cmd.caseId !== undefined) rows = rows.filter((r) => r.caseId === cmd.caseId);
	if (rows.length === 0) {
		// No artifact: either the run has none (or this filter matches none), or
		// the legacy run has no artifacts.jsonl at all. Neither is an error.
		console.log(`No artifact found for run ${cmd.runId}${cmd.skillId ? ` / skill ${cmd.skillId}` : ""}${cmd.caseId ? ` / case ${cmd.caseId}` : ""}.`);
		return;
	}
	for (const r of rows) {
		if (r.truncated) {
			console.error(chalk.yellow(`NOTE: artifact for ${r.skillId}:${r.caseId} was truncated to ${r.bytes} bytes at persistence (ARTIFACT_MAX_BYTES); its sha256 is NOT the ledger digest.`));
		}
		process.stdout.write(r.artifact);
		if (!r.artifact.endsWith("\n")) process.stdout.write("\n");
	}
}

async function printAudit(cmd: Extract<RepoSkillsCommand, { type: "audit" }>, qualityDir: string): Promise<void> {
	const { benchmarkRoot, json, runId, candidate, source, split, executor, skillId, caseId, skillRoot, candidateManifestFile, candidateRoot, agentBaseUrl, agentModel, agentApiKeyEnv } = cmd;
	if (executor === "agent") {
		// B2: single-case agent execution. Persisted as kind=agent-eval — a
		// DISTINCT runKind and metric label from the proxy candidate-eval path.
		// P0-2: when a gateway is configured (explicit flags or DISCO_GATEWAY_*
		// env), the REAL ModelAgentDriver (multi-round + tool loop) is wired in;
		// otherwise the fake driver stands in so the interface path still runs.
		try {
			const baseUrl = agentBaseUrl ?? process.env["DISCO_GATEWAY_URL"];
			const model = agentModel ?? process.env["DISCO_GATEWAY_MODEL"];
			const apiKeyEnv = agentApiKeyEnv ?? "DISCO_GATEWAY_KEY";
			const apiKey = process.env[apiKeyEnv];
			const driver =
				baseUrl && model && apiKey
					? new ModelAgentDriver({
							baseUrl,
							apiKey,
							model,
							maxTokens: DEFAULT_AGENT_CONFIG.tokenBudget,
						})
					: undefined;
			const result = await runAgentEval({
				benchmarkRoot,
				qualityDir,
				runId: runId!,
				skillId: skillId!,
				caseId: caseId!,
				skillRoot,
				candidate: candidateManifestFile && candidateRoot ? { manifestFile: candidateManifestFile, stagedRoot: candidateRoot } : undefined,
				config: { ...DEFAULT_AGENT_CONFIG },
				driver,
			});
			if (json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}
			console.log(`Agent eval persisted: ${result.runId} (${result.skillId}:${result.caseId})`);
			console.log(`runKind: ${result.runKind} | executor=${result.executor} | driver=${result.driver} | model=${result.model}`);
			if (result.candidateId) console.log(`candidateId=${result.candidateId} | skillDigest=${result.candidateSha256}`);
			console.log(`status=${result.status} | artifactSha256=${result.artifactSha256 ?? "null"}`);
			if (result.usage && (result.usage.modelCalls ?? 0) > 0) {
				console.log(`usage: modelCalls=${result.usage.modelCalls} tokens=${result.usage.totalTokens ?? "n/a"} toolCalls=${result.usage.toolCalls ?? 0} wallMs=${result.usage.wallMs ?? "n/a"}`);
			}
			console.log(`Ledger: ${result.ledgerPath}`);
			console.log(`NOTICE: ${result.note}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: agent eval failed: ${message}`));
			process.exitCode = 1;
		}
		return;
	}
	if (runId !== undefined && candidate !== undefined) {
		// Candidate evaluation run-batch: score a candidate artifact with the
		// deterministic model-grader proxy and persist kind=candidate-eval.
		try {
			const result = await runCandidateEval({ benchmarkRoot, qualityDir, runId, candidateText: candidate, source, split: split as ReadonlyArray<"train" | "dev"> | undefined });
			if (json) {
				console.log(JSON.stringify({ ...result, kind: "candidate-eval" }, null, 2));
				return;
			}
			const rate = result.taskSuccessRate;
			console.log(`Candidate eval persisted: ${result.runId}`);
			console.log(`Candidate sha256: ${result.candidateSha256}`);
			console.log(`Ledger: ${result.ledgerPath}`);
			console.log(`candidate task_success_rate: ${rate === null ? "n/a" : (rate * 100).toFixed(1) + "%"}`);
			console.log(`NOTE: ${result.note}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: candidate eval failed: ${message}`));
			process.exitCode = 1;
		}
		return;
	}

	if (runId !== undefined) {
		// Full deterministic baseline run + persistence (plumbing, not quality).
		let loaded;
		try {
			loaded = loadBenchmark(benchmarkRoot, split as ReadonlyArray<"train" | "dev" | "heldout"> | undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: could not load benchmark at ${benchmarkRoot}: ${message}`));
			process.exitCode = 1;
			return;
		}
		const deps = buildBaselineDeps();
		// BUG-P1-10: real UTC runAt for production baseline audits.
		const result = await runAudit(loaded.cases, { runId, runAt: new Date().toISOString() }, { executor: deps.executor, grader: deps.grader, splitIndex: loaded.splitIndex });
		const persisted = persistAuditRun(result, { qualityDir, kind: "baseline-plumbing" });
		if (json) {
			console.log(JSON.stringify({ ...result.summary, kind: "baseline-plumbing", ledgerPath: persisted.ledgerPath, note: result.summary.taskSuccessRate === null ? undefined : "baseline-plumbing: deterministic grader, NOT a routing quality result." }, null, 2));
			return;
		}
		console.log(`Audit run persisted: ${persisted.runId}`);
		console.log(`Ledger: ${persisted.ledgerPath}`);
		console.log(`Summary: ${persisted.summaryPath}`);
		const rate = result.summary.taskSuccessRate;
		console.log(`Baseline task_success_rate: ${rate === null ? "n/a" : (rate * 100).toFixed(1) + "%"}`);
		console.log("NOTE: deterministic plumbing baseline (no live agent/human grading). NOT a routing-quality result.");
		return;
	}

	let preflight;
	try {
		preflight = auditPreflight(benchmarkRoot);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: could not load benchmark at ${benchmarkRoot}: ${message}`));
		process.exitCode = 1;
		return;
	}
	if (json) {
		console.log(JSON.stringify(preflight, null, 2));
		return;
	}
	console.log(`Benchmark: ${preflight.manifestName} (split ${preflight.splitHash.slice(0, 12)}…)`);
	console.log(`Cases: ${preflight.caseCount} across ${preflight.skillCount} skills`);
	for (const split of Object.keys(preflight.perSplit).sort()) {
		console.log(`  split ${split}: ${preflight.perSplit[split]} case(s)`);
	}
	console.log(`L0-valid cases: ${preflight.l0Valid}/${preflight.caseCount}`);
	if (preflight.contentHashVerified) {
		console.log(`Content digest ${preflight.contentHash.slice(0, 16)}… (matches manifest)`);
	} else {
		console.warn(`Content digest ${preflight.contentHash.slice(0, 16)}… (manifest has no matching contentHash — benchmark content is not frozen; see P2-01)`);
	}
	if (preflight.l0Invalid.length > 0) {
		process.exitCode = 1;
		for (const bad of preflight.l0Invalid) {
			console.error(chalk.yellow(`  ! ${bad.skillId}/${bad.caseId}: ${bad.reason}`));
		}
	}
	console.log(`Benchmark dir: ${benchmarkRoot}`);
}

function printEvolve(cmd: Extract<RepoSkillsCommand, { type: "evolve" }>): void {
	// Propose-only controller flow: idle -> planning -> proposing -> archived.
	const ctl = new EvolutionController();
	const input: ProposeInput = {
		roundId: cmd.roundId,
		targetSkillId: cmd.targetSkillId,
		hypothesis: cmd.hypothesis,
		plan: cmd.plan,
		evidence: { source: cmd.source, finding: cmd.finding, empirical: cmd.empirical },
		generatedAt: new Date().toISOString(), // BUG-P1-10: real UTC generation time
	};
	try {
		ctl.transition("planning");
		ctl.transition("proposing");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return;
	}
	const proposal = makeProposal(input);
	ctl.transition("archived");
	// Hard guard: the proposal was never applied to the live tree.
	if (ctl.tryApply() !== false) {
		console.error(chalk.red("Internal error: propose-only guard violated."));
		process.exitCode = 1;
		return;
	}
	if (cmd.json) {
		console.log(JSON.stringify(proposal, null, 2));
		return;
	}
	console.log(`Evolve round (propose-only): ${proposal.roundId} → target ${proposal.targetSkillId}`);
	console.log(`Hypothesis: ${proposal.hypothesis}`);
	console.log("Plan (NOT applied to live tree):");
	for (const p of proposal.plan) console.log(`  - ${p}`);
	console.log(`Evidence: ${proposal.evidence.source} | finding="${proposal.evidence.finding}" | empirical=${proposal.evidence.empirical}`);
	console.log("Propose-only: this proposal does NOT modify any skill. Promotion is a separate, human-gated Step 5 action.");
}

async function printBaseline(benchmarkRoot: string, json: boolean, seed: string, grader: "token" | "structure", split?: unknown): Promise<void> {
	let comparison;
	try {
		const graderImpl = grader === "structure" ? structureGrader() : undefined;
		comparison = await compareBaselines(benchmarkRoot, seed, undefined, graderImpl, split as ReadonlyArray<"train" | "dev"> | undefined);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: could not compute baseline comparison at ${benchmarkRoot}: ${message}`));
		process.exitCode = 1;
		return;
	}
	const fmt = (v: number | null): string => (v === null ? "n/a" : (v * 100).toFixed(1) + "%");
	if (json) {
		console.log(JSON.stringify(comparison, null, 2));
		return;
	}
	console.log(`Equal-budget baseline harness (seed=${seed}, grader=${grader}) over ${comparison.caseCount} cases:`);
	for (const arm of ["B0_retry", "B1_random_edit", "B2_propose"] as const) {
		console.log(`  ${arm}: task_success_rate ${fmt(comparison.arms[arm].taskSuccessRate)}`);
	}
	console.log(`NOTE: ${comparison.note}`);
}

export interface FamilyManifest {
	runId?: string;
	candidates: CandidateFamilyMember[];
}

export function readFamilyManifest(filePath: string): FamilyManifest {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		throw new RepoSkillsLibraryError(`family: cannot read candidates file at ${filePath}`, 2);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new RepoSkillsLibraryError(`family: ${filePath} is not valid JSON`, 2);
	}
	const man = parsed as Partial<FamilyManifest>;
	if (!Array.isArray(man.candidates) || man.candidates.length === 0) {
		throw new RepoSkillsLibraryError("family: candidates manifest must contain a non-empty 'candidates' array.", 2);
	}
	for (const c of man.candidates) {
		if (!c || typeof c.candidateId !== "string" || typeof c.text !== "string") {
			throw new RepoSkillsLibraryError("family: each candidate requires { candidateId: string, text: string }.", 2);
		}
	}
	return { runId: man.runId ?? "family", candidates: man.candidates as CandidateFamilyMember[] };
}

async function printFamily(benchmarkRoot: string, json: boolean, candidatesFile: string, qualityDir: string, split?: unknown): Promise<void> {
	let manifest: FamilyManifest;
	try {
		manifest = readFamilyManifest(candidatesFile);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return;
	}
	try {
		const result = await runCandidateRegression({ benchmarkRoot, qualityDir, runId: manifest.runId ?? "family", candidates: manifest.candidates, split: split as ReadonlyArray<"train" | "dev"> | undefined });
		if (json) {
			console.log(JSON.stringify({ ...result, kind: "candidate-family" }, null, 2));
			return;
		}
		console.log(`Candidate-family regression (runId=${result.runId}) over ${result.caseCount} cases:`);
		for (const pc of result.perCandidate) {
			const rate = pc.taskSuccessRate === null ? "n/a" : (pc.taskSuccessRate * 100).toFixed(1) + "%";
			console.log(`  ${pc.candidateId}: ${rate}  ${pc.candidateSha256.slice(0, 10)}…`);
		}
		console.log(`NOTE: ${result.note}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: family regression failed: ${message}`));
		process.exitCode = 1;
	}
}

async function printHeldoutFinalEval(cmd: Extract<RepoSkillsCommand, { type: "heldoutFinalEval" }>, qualityDir: string): Promise<void> {
	const { benchmarkRoot, json, runId, candidate, source } = cmd;
	try {
		const result = await runHeldoutFinalEval({ benchmarkRoot, qualityDir, runId, candidateText: candidate, source });
		if (json) {
			console.log(JSON.stringify({ ...result, kind: HELDOUT_FINAL_EVAL_KIND }, null, 2));
			return;
		}
		const rate = result.taskSuccessRate === null ? "n/a" : (result.taskSuccessRate * 100).toFixed(1) + "%";
		console.log(`Held-out final eval persisted: ${result.runId} (kind=${HELDOUT_FINAL_EVAL_KIND})`);
		console.log(`Candidate sha256: ${result.candidateSha256}`);
		console.log(`Ledger: ${result.ledgerPath}`);
		console.log(`Held-out task_success_rate: ${rate} over ${result.caseCount} held-out case(s)`);
		console.log(`NOTE: ${result.note}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: held-out final eval failed: ${message}`));
		process.exitCode = 1;
	}
}

function printPool(json: boolean, family: string | undefined, qualityDir: string): void {
	const runs = listCandidateRuns(qualityDir);
	const selected = family ? poolByFamily(runs, family) : runs;
	if (json) {
		console.log(JSON.stringify({ family, runs: selected.map((r) => ({ ...r, kind: "candidate-eval" })) }, null, 2));
		return;
	}
	if (selected.length === 0) {
		console.log(`No recorded candidate-eval runs${family ? ` under family "${family}"` : ""} in ${qualityDir}.`);
		return;
	}
	console.log(`Pooled candidate-eval runs (${selected.length}):`);
	for (const r of selected) {
		const rate = r.taskSuccessRate === null ? "n/a" : (r.taskSuccessRate * 100).toFixed(1) + "%";
		console.log(`  ${r.runId}: ${rate}  sha ${r.candidateSha256 ? r.candidateSha256.slice(0, 10) + "…" : "n/a"}  gradedBy=${r.gradedBy}`);
	}
	console.log("NOTE: reads only already-recorded runs; no re-grading, no new claims.");
}

/**
 * Family-disparity view: one compact table per family member, showing its overall rate,
 * grading sources, and per-skill digest-level Δ vs a baseline run. Read-only; reuses the
 * same digest-merge + skill-delta aggregation as evalreport. Honest labeling is preserved.
 */
function printFamilyDisparity(json: boolean, qualityDir: string, family: string | undefined, baseline: string | undefined, merge: DigestMergeStrategy): void {
	const runs = listCandidateRuns(qualityDir);
	const selected = family ? poolByFamily(runs, family) : runs;
	if (selected.length === 0) {
		console.log(`No recorded candidate-eval runs${family ? ` under family "${family}"` : ""} in ${qualityDir}.`);
		return;
	}
	const bl = baseline !== undefined ? readBaselineByCase(qualityDir, baseline) : null;
	const rows = selected
		.map((r) => {
			const digest = r.candidateSha256 ?? null;
			let skillDelta: DigestSkillDelta[] | null = null;
			let candCovered = 0;
			if (digest && bl && bl.found) {
				const ds = readDigestCaseScores(qualityDir, digest.slice(0, 12), { merge });
				candCovered = ds.candidateCovered;
				skillDelta = ds.byCase.size > 0 ? aggregateSkillDeltaByDigest(ds, bl.byCase) : null;
			}
			const rate = r.taskSuccessRate === null ? null : r.taskSuccessRate * 100;
			let sources = r.gradedBy ?? "n/a";
			if (digest && bl && bl.found && skillDelta !== null && skillDelta.length > 0) {
				const uniq = new Set<string>();
				for (const d of skillDelta) for (const g of d.candidateGradedBy.split("|")) if (g) uniq.add(g);
				if (uniq.size > 0) sources = [...uniq].sort().join("|");
			}
			return { runId: r.runId, rate, digest, covered: candCovered, skillDelta, sources };
		})
		.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
	if (json) {
		console.log(JSON.stringify({ family, baseline, merge, members: rows }, null, 2));
		return;
	}
	console.log(`Family disparity view (${rows.length} member(s))${baseline ? ` vs baseline ${baseline}` : ""}:`);
	for (const m of rows) {
		const rate = m.rate === null ? "n/a" : m.rate.toFixed(1) + "%";
		console.log(`  ${m.runId}: ${rate}  sha ${m.digest ? m.digest.slice(0, 10) + "…" : "n/a"}  sources=${m.sources}`);
		if (m.skillDelta && m.skillDelta.length > 0) {
			const parts = m.skillDelta.map((d) => `${d.skillId}=${d.meanDelta === null ? "n/a" : (d.meanDelta >= 0 ? "+" : "") + (d.meanDelta * 100).toFixed(1) + "pts(" + d.comparedCases + ")"}`);
			console.log(`      ${parts.join("  ")}`);
		} else if (m.skillDelta !== null) {
			console.log(`      (no overlapping baseline cases; Δ n/a)`);
		}
	}
	console.log(
		"NOTE: per-skill Δ is a numeric mean difference on overlapping cases vs the baseline; candidate and baseline may come from different graders (mixed sources reported). NOT a routing-quality or causal claim."
	);
}

export function readGradeManifest(filePath: string): InjectGradeRequest[] {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		throw new RepoSkillsLibraryError(`grade: cannot read manifest at ${filePath}`, 2);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new RepoSkillsLibraryError(`grade: ${filePath} is not valid JSON`, 2);
	}
	const items = Array.isArray(parsed) ? (parsed as unknown[]) : (parsed as { grades?: unknown[] }).grades;
	if (!Array.isArray(items) || items.length === 0) {
		throw new RepoSkillsLibraryError("grade manifest must be an array (or {grades:[...]}) with at least one item.", 2);
	}
	const reqs: InjectGradeRequest[] = [];
	for (const it of items) {
		const g = it as { runId?: unknown; skillId?: unknown; caseId?: unknown; score?: unknown; gradedBy?: unknown; note?: unknown; reviewerId?: unknown; rubricVersion?: unknown; evidenceRef?: unknown };
		if (typeof g.runId !== "string" || typeof g.skillId !== "string" || typeof g.caseId !== "string" || typeof g.score !== "number") {
			throw new RepoSkillsLibraryError("grade manifest item requires { runId, skillId, caseId (strings), score (number) }.", 2);
		}
		const gradedBy = g.gradedBy === "model_grader" ? "model_grader" : "human";
		reqs.push({
			qualityDir: "",
			runId: g.runId,
			skillId: g.skillId,
			caseId: g.caseId,
			score: g.score,
			gradedBy,
			note: typeof g.note === "string" ? g.note : undefined,
			// B3: propagate reviewer/rubric/evidence from the manifest so batch human
			// grades carry the same identity contract as the single-grade path.
			reviewerId: typeof g.reviewerId === "string" ? g.reviewerId : undefined,
			rubricVersion: typeof g.rubricVersion === "string" ? g.rubricVersion : undefined,
			evidenceRef: typeof g.evidenceRef === "string" ? g.evidenceRef : undefined,
		});
	}
	return reqs;
}

function printGradeFromJson(filePath: string, by: "human" | "model_grader"): void {
	let reqs: InjectGradeRequest[];
	try {
		reqs = readGradeManifest(filePath);
		// qualityDir is filled by the caller context; clone so each has the real dir.
		reqs = reqs.map((r) => ({ ...r, qualityDir: getRsiQualityDir(), gradedBy: r.gradedBy === "model_grader" ? "model_grader" : by }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return;
	}
	const batch = injectGrades(reqs);
	if (batch.applied === 0 && batch.failed.length === 0) {
		console.log("No grades to apply.");
		return;
	}
	console.log(`Grade batch: applied ${batch.applied}, skipped ${batch.skipped}, failed ${batch.failed.length}.`);
	for (const f of batch.failed) console.error(chalk.red(`  - ${f.key}: ${f.reason}`));
	console.log("NOTE: real grades injected into candidate-eval ledgers; recomputed per-run task_success_rate.");
	if (batch.failed.length > 0) process.exitCode = 1;
}

function printEvalReport(json: boolean, run: string | undefined, baseline: string | undefined, candidate: string | undefined, merge: "mean" | "latest", qualityDir: string): void {
	const rep = buildScoreReport(qualityDir, { filterRunId: run });
	const bl: BaselineReading | null = baseline !== undefined ? readBaselineRate(qualityDir, baseline) : null;
	const blByCase: BaselineByCase | null = baseline !== undefined ? readBaselineByCase(qualityDir, baseline) : null;
	// BUG-P1-15: failure exit codes must not depend on the output format.
	if (bl !== null && !bl.found) process.exitCode = 1;
	if (bl !== null && bl.found && bl.rate === null) process.exitCode = 1;
	let candidateAnalysis: {
		matchedRuns: number;
		candidateCovered: number;
		overlapped: number;
		candidateOnly: number;
		baselineOnly: number;
		skillDeltas: DigestSkillDelta[];
	} | null = null;
	let candidateError: string | null = null;
	if (candidate !== undefined) {
		if (blByCase === null || !blByCase.found) {
			candidateError = `--candidate ${candidate}: baseline run required (--baseline) and must exist.`;
		} else {
			const ds = readDigestCaseScores(qualityDir, candidate, { merge });
			if (ds.byCase.size === 0) {
				candidateError = `--candidate ${candidate}: no candidate-eval ledger rows match this digest prefix.`;
			} else {
				let overlapped = 0;
				for (const key of ds.byCase.keys()) if (blByCase.byCase.has(key)) overlapped += 1;
				candidateAnalysis = {
					matchedRuns: ds.matchedRuns,
					candidateCovered: ds.candidateCovered,
					overlapped,
					candidateOnly: ds.candidateCovered - overlapped,
					baselineOnly: blByCase.byCase.size - overlapped,
					skillDeltas: aggregateSkillDeltaByDigest(ds, blByCase.byCase),
				};
			}
		}
	}
	if (candidateError !== null || rep.issues.length > 0) process.exitCode = 1;
	if (json) {
		console.log(
			JSON.stringify(
				{
					run,
					candidate,
					candidateAnalysis,
					candidateError,
					baseline: bl ? { runId: bl.runId, rate: bl.rate, kind: bl.kind, note: bl.note } : null,
					baselineByCaseCount: blByCase !== null && blByCase.found ? blByCase.caseCount : 0,
					coverage: run !== undefined && blByCase !== null && blByCase.found ? coverageGap(rep.byCase, run, blByCase.byCase) : null,
					runs: rep.runs,
					byCase: rep.byCase,
					byCandidate: rep.byCandidate,
					issues: rep.issues,
				},
				null,
				2,
			),
		);
		return;
	}
	// Candidate aggregation only makes sense across multiple runs; in a single-run
	// view the per-case table is omitted anyway.
	if (rep.runs.length === 0 && rep.issues.length === 0) {
		console.log(`No candidate-eval ledger runs found${run ? ` for "${run}"` : ""} in ${qualityDir}.`);
		return;
	}
	console.log(`Score report (${rep.runs.length} candidate-eval run(s)):`);
	for (const r of rep.runs) {
		const rate = r.taskSuccessRate === null ? "n/a" : (r.taskSuccessRate * 100).toFixed(1) + "%";
		console.log(`  ${r.runId}: ${rate}  rows=${r.ledgerRowCount}  sha ${r.candidateSha256 ? r.candidateSha256.slice(0, 10) + "…" : "n/a"}  graders=${JSON.stringify(r.gradedByCounts)}`);
	}
	if (bl) {
		if (!bl.found) {
			console.error(chalk.yellow(`  --baseline ${baseline}: run not found; omitting deltas.`));
			process.exitCode = 1;
		} else if (bl.rate === null) {
			console.error(chalk.yellow(`  --baseline ${baseline}: run has no recorded task_success_rate; omitting deltas.`));
			process.exitCode = 1;
		}
	}
	if (run === undefined) {
		console.log("Per-candidate (mean over scored rows, descending):");
		for (const c of rep.byCandidate) {
			const m = c.mean === null ? "n/a" : (c.mean * 100).toFixed(1) + "%";
			// BUG (unequal case sets): Δ = c.mean - bl.rate is only meaningful when the
			// digest and the baseline were scored over the SAME case population. The
			// per-skill deltas intersect cases explicitly; this top-level number must not
			// subtract means over unequal denominators. Emit n/a when the digest's unique
			// case count differs from the baseline's scored case set.
			const comparable = blByCase !== null && blByCase.found && blByCase.byCase.size === c.caseCount && c.caseCount > 0;
			const delta = comparable && bl !== null && bl.rate !== null && c.mean !== null
				? `  Δ=${((c.mean - bl.rate) * 100).toFixed(1)}pts`
				: (bl !== null && bl.found && c.mean !== null ? `  Δ=n/a (unequal case sets)` : "");
			console.log(`  ${c.candidateSha256 ? c.candidateSha256.slice(0, 10) + "…" : "<null>"}: ${m}  cases=${c.caseCount}  sources=${c.gradedBySources.join(",")}${delta}` + (c.perSkill.length ? `  ${c.perSkill.map((s) => `${s.skillId}=${(s.mean! * 100).toFixed(1)}%(${s.caseCount})`).join(" ")}` : ""));
		}
		if (bl !== null && bl.found && bl.rate !== null) {
			console.log(`Baseline ${bl.runId} (${bl.kind}): ${(bl.rate * 100).toFixed(1)}%. Δ is a numeric difference only and only printed when candidate and baseline cover the same case set; candidate means and baseline may come from different graders/sources.`);
		}
	}
	if (candidate !== undefined) {
		if (candidateError !== null || candidateAnalysis === null) {
			console.error(chalk.yellow(`  ${candidateError ?? "candidate comparison unavailable"}`));
			return;
		}
		console.log(`Digest ${candidate} (merge=${merge}): covered ${candidateAnalysis.candidateCovered} case(s) across ${candidateAnalysis.matchedRuns} run(s); overlapped with baseline ${candidateAnalysis.overlapped}, candidate-only ${candidateAnalysis.candidateOnly}, baseline-only ${candidateAnalysis.baselineOnly}.`);
		if (candidateAnalysis.skillDeltas.length === 0) {
			console.log("Skill Δbase: no cases overlap between this digest and the baseline; nothing to compare.");
		} else {
			console.log(`Skill Δbase for digest ${candidate} vs ${blByCase!.runId} (mean over overlapping cases):`);
			for (const s of candidateAnalysis.skillDeltas) {
				const d = s.meanDelta === null ? "n/a" : `${s.meanDelta >= 0 ? "+" : ""}${(s.meanDelta * 100).toFixed(1)}pts`;
				console.log(`  ${s.skillId}: ${d}  over ${s.comparedCases} case(s)  cand=${s.candidateGradedBy}  baseline=${s.baselineGradedBy}`);
			}
			console.log("Δ is numeric only; digest may merge scores across multiple runs and graders.");
		}
	}
	let caseShown = 0;
	for (const c of rep.byCase) {
		if (run !== undefined) continue; // single-run view omits the per-case cross-run table
		if (candidate !== undefined) continue; // digest view omits per-case cross-run table
		if (caseShown >= 12) break;
		const cells = c.entries.map((e) => `${e.runId}=${e.score ?? "n/a"}(${e.gradedBy})`).join(", ");
		const bEntry = blByCase !== null && blByCase.found ? blByCase.byCase.get(`${c.skillId}::${c.caseId}`) : undefined;
		const bCell = bEntry === undefined ? (blByCase !== null && blByCase.found ? " Δbase=-" : "") : ` Δbase=${bEntry.score === null ? "n/a" : bEntry.score}(bl:${bEntry.gradedBy})`;
		console.log(`  ${c.skillId}:${c.caseId}  ${cells}${bCell}`);
		caseShown += 1;
	}
	if (blByCase !== null && blByCase.found && blByCase.caseCount > 0) {
		console.log(`Baseline by-case: ${blByCase.runId} (${blByCase.kind}) covers ${blByCase.caseCount} case(s). Δbase is numeric only; candidate and baseline scores may come from different graders.`);
	}
	if (run !== undefined && blByCase !== null && blByCase.found) {
		const gap = coverageGap(rep.byCase, run, blByCase.byCase);
		console.log(`Coverage: candidate covered ${gap.candidateCovered}, overlapped with baseline ${gap.overlapped}, candidate-only ${gap.candidateOnly}, baseline-only ${gap.baselineOnly}.`);
		if (gap.candidateOnlyCases.length > 0) {
			console.log(`  candidate-only cases (no baseline, so excluded from Δ): ${gap.candidateOnlyCases.join(", ")}${gap.candidateOnly > gap.candidateOnlyCases.length ? `, +${gap.candidateOnly - gap.candidateOnlyCases.length} more` : ""}`);
		}
		const sds = aggregateSkillDeltaFromCases(rep.byCase, run, blByCase.byCase);
		if (sds.length === 0) {
			console.log("Skill Δbase: no cases overlap between this run and the baseline; nothing to compare.");
		} else {
			console.log(`Skill Δbase for ${run} vs ${blByCase.runId} (mean over ${gap.overlapped} overlapping case(s)):`);
			for (const s of sds) {
				const d = s.meanDelta === null ? "n/a" : `${s.meanDelta >= 0 ? "+" : ""}${(s.meanDelta * 100).toFixed(1)}pts`;
				console.log(`  ${s.skillId}: ${d}  over ${s.comparedCases} case(s)  baseline=${s.baselineGradedBy}`);
			}
		}
	}
	for (const i of rep.issues) {
		console.error(chalk.yellow(`  issue [${i.kind}] ${i.runId}: ${i.detail}`));
	}
	if (rep.issues.length > 0) {
		console.log("NOTE: structural issues above are surfaced, not auto-fixed.");
		process.exitCode = 1;
	}
}

function printConsistency(json: boolean, qualityDir: string, docsDir: string): void {
	const res = auditConsistency({ qualityDir, docsRsiDir: docsDir });
	// BUG-P1-15: failure exit code must not depend on output format.
	if (res.failed > 0) process.exitCode = 1;
	if (json) {
		console.log(JSON.stringify({ qualityDir, docsDir, checks: res.checks, passed: res.passed, failed: res.failed, warnings: res.warnings, skipped: res.skipped, byRun: res.byRun, unassigned: res.unassigned }, null, 2));
		return;
	}
	console.log(`Runtime consistency audit (${res.passed}/${res.checks.length - res.skipped} passed, ${res.skipped} skipped/NO_DATA, ${res.warnings} informational warning(s)):`);
	for (const c of res.checks) {
		if (c.status === "skip") {
			console.log(`  [no-data] ${c.name}: ${c.detail}`);
			continue;
		}
		if (c.pass && c.level === "warning") {
			console.log(`  [warn] ${c.name}: ${c.detail}`);
			continue;
		}
		const mark = c.pass ? "PASS" : "FAIL";
		console.log(`  [${mark}] ${c.name}: ${c.detail}`);
	}
	const runIds = Object.keys(res.byRun).sort();
	if (runIds.length > 0) {
		console.log("Issues by run:");
		for (const id of runIds) {
			const r = res.byRun[id];
			console.log(`  ${id}: ${r.errors.length} error(s), ${r.warnings.length} warning(s)  [checks: ${r.checks.join(",")}]`);
		}
	}
	if (res.failed > 0) {
		console.log("NOTE: this audit reports inconsistency; it does not auto-fix. Review the failed checks.");
		process.exitCode = 1;
	}
}

export async function handleRepoSkillsCommand(
	args: string[],
	options: RepoSkillsCommandHandlerOptions = {},
): Promise<boolean> {
	let command: RepoSkillsCommand | undefined;
	try {
		command = parseRepoSkillsCommand(args);
	} catch (error) {
		if (args.filter((arg) => arg !== "--offline")[0] !== "repo-skills") return false;
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = error instanceof RepoSkillsLibraryError ? error.exitCode : 1;
		return true;
	}
	if (!command) return false;
	if (command.type === "help") {
		printRepoSkillsHelp();
		return true;
	}

	const eventsDir = getRsiEventsDir();
	const healthPath = getRsiHealthPath();

	if (command.type === "usage") {
		printUsage(eventsDir);
		return true;
	}
	if (command.type === "report") {
		printReport(eventsDir, healthPath, command.json);
		persistHealth(eventsDir, buildUsageReport(eventsDir).health);
		return true;
	}
	if (command.type === "ledger") {
		printLedger(eventsDir, command.json);
		return true;
	}
	if (command.type === "artifact") {
		printArtifact(command, getRsiQualityDir());
		return true;
	}
	if (command.type === "audit") {
		await printAudit(command, getRsiQualityDir());
		return true;
	}
	if (command.type === "evolve") {
		printEvolve(command);
		return true;
	}
	if (command.type === "baseline") {
		await printBaseline(command.benchmarkRoot, command.json, command.seed, command.grader, command.split);
		return true;
	}
	if (command.type === "candidate") {
		try {
			const res = runCandidateAuthor({
				skillId: command.skillId,
				skillRoot: command.skillRoot,
				patchFile: command.patchFile,
				author: command.author,
				reason: command.reason,
				stagingDir: command.stagingDir,
				out: command.out,
			});
			if (command.json) {
				console.log(JSON.stringify(res, null, 2));
			} else {
				console.log(`Candidate authored: ${res.candidateId.slice(0, 12)}… for skill ${res.targetSkillId}`);
				console.log(`  manifest: ${res.manifestFile}`);
				console.log(`  parent  → result digest: ${res.parentSkillDigest.slice(0, 12)}… → ${res.resultSkillDigest.slice(0, 12)}…`);
				console.log(`  staged tree: ${res.stagedRoot}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: ${message}`));
			process.exitCode = error instanceof CandidateCliError ? error.exitCode : 1;
		}
		return true;
	}
	if (command.type === "family") {
		await printFamily(command.benchmarkRoot, command.json, command.candidatesFile, getRsiQualityDir(), command.split);
		return true;
	}
	if (command.type === "heldoutFinalEval") {
		await printHeldoutFinalEval(command, getRsiQualityDir());
		return true;
	}
	if (command.type === "pool") {
		printPool(command.json, command.family, getRsiQualityDir());
		return true;
	}
	if (command.type === "grade") {
		if (command.fromJson !== undefined) {
			printGradeFromJson(command.fromJson, command.by);
			return true;
		}
		const res = injectGrade({ qualityDir: getRsiQualityDir(), runId: command.runId!, skillId: command.skillId!, caseId: command.caseId!, score: command.score!, gradedBy: command.by, note: command.note, reviewerId: command.reviewerId, rubricVersion: command.rubricVersion, evidenceRef: command.evidenceRef });
		if (res.applied) {
			const rate = res.taskSuccessRate === null ? "n/a" : (res.taskSuccessRate * 100).toFixed(1) + "%";
			console.log(`Grade injected: ${command.by} ${command.score} for ${command.skillId}:${command.caseId} (run ${command.runId}).`);
			console.log(`Updated task_success_rate: ${rate}`);
		} else {
			console.error(chalk.red(`Error: ${res.reason ?? "grade injection failed"}`));
			process.exitCode = 1;
		}
		return true;
	}
	if (command.type === "judgement") {
		const res = appendJudgement({
				eventsDir: getRsiEventsDir(),
				runId: command.runId,
				skillId: command.skillId,
				caseId: command.caseId,
			score: command.score,
			source: command.by,
			reviewerId: command.reviewerId,
			rubricVersion: command.rubricVersion,
			evidenceRef: command.evidenceRef,
		});
		if (res.appended) {
			console.log(`Judgement appended: ${command.by} ${command.score} for ${command.skillId} (event ${res.eventId}).`);
			console.log(`File: ${res.file}`);
		} else {
			console.error(chalk.red(`Error: ${res.reason ?? "judgement append failed"}`));
			process.exitCode = 1;
		}
		return true;
	}
	if (command.type === "evalreport") {
		printEvalReport(command.json, command.run, command.baseline, command.candidate, command.merge ?? "mean", getRsiQualityDir());
		return true;
	}
	if (command.type === "auditConsistency") {
		const docsDir = command.docs ?? resolveDocsRsiDefault();
		printConsistency(command.json, getRsiQualityDir(), docsDir);
		return true;
	}
	if (command.type === "familyDisparity") {
		printFamilyDisparity(command.json, getRsiQualityDir(), command.family, command.baseline, command.merge);
		return true;
	}

	const manager = options.manager ?? new RepoSkillsLibraryManager();
	try {
		if (command.type === "install") printInstallResult(await manager.install({ force: command.force }));
		else if (command.type === "update") printInstallResult(await manager.update({ force: command.force }));
		else if (command.type === "status") {
			const status = manager.status();
			printStatus(status);
			if (status.issues.length > 0) process.exitCode = 1;
		} else if (command.type === "router") {
			printRouterResult(await manager.setRouterEnabled(command.enabled));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = error instanceof RepoSkillsLibraryError ? error.exitCode : 1;
	}
	return true;
}
