/**
 * Repo Skill Observer — event schema.
 *
 * These are the machine-readable "observation facts" rows recorded by the RSI
 * observer. They model how the agent discovered, read and executed repository
 * skills at runtime, WITHOUT capturing prompts, response bodies, API keys,
 * absolute working directories or raw tool stdout (see the tight privacy
 * contract in the RSI plan).
 *
 * IMPORTANT — inference vs fact: reading events are facts; "routing was
 * correct" or "the task succeeded" are inferences that REQUIRE a labelled
 * source (assertion / human / declared grader). `run_settled` only records a
 * technical status, never a success judgement.
 */

export const REPO_SKILL_EVENT_SCHEMA_VERSION = 1 as const;

export type TechnicalStatus = "completed" | "tool_error" | "aborted" | "timeout";
export type JudgementSource = "assertion" | "human" | "model_grader" | "none";

/** Discriminating event type for a repo-skill observation row. */
export type RepoSkillEventType =
	| "router_read" // 读取 router (repo-skills-router / index)
	| "taxonomy_read" // 读取 taxonomy / assignments index
	| "skill_root_read" // 读取某个 repo-skill 的根 SKILL.md
	| "sub_skill_read" // 读取某个 repo-skill 的子技能 SKILL.md
	| "reference_read" // 读取 references/ 下的知识文件
	| "script_read" // 读取（并非执行）repo-skill 内 bundled script 文件
	| "script_call" // 执行 repo-skill 内 bundled script
	| "run_settled" // 一次运行结束（仅技术状态）
	| "task_judgement"; // 外部判定（assertion/human/grader），默认不产生

/**
 * A single observation row. Immutable-shaped; consumers should treat each row
 * as one fact about one skill-related action.
 */
export interface RepoSkillEvent {
	schemaVersion: typeof REPO_SKILL_EVENT_SCHEMA_VERSION;
	/** Stable unique id for this row. */
	eventId: string;
	/** ISO-8601 timestamp. */
	ts: string;
	/** Local random session id (re-issued per session, never a user account id). */
	sessionId: string;
	/** Agent turn id this row belongs to. */
	turnId: string;
	eventType: RepoSkillEventType;
	/** Canonical repo-skill id, when determinable from the path/command. */
	skillId?: string;
	/** Sub-skill id, when determinable and distinct from skillId. */
	subSkillId?: string;
	/** Taxonomy area, when determinable. */
	area?: string;
	/** Taxonomy family, when determinable. */
	family?: string;
	/** Latency in ms for script_call only. */
	latencyMs?: number;
	/** Technical status; only meaningful on run_settled. */
	technicalStatus?: TechnicalStatus;
	/** True when a script_call or tool call associated with a skill errored. */
	isError?: boolean;
	/** Judgement source; only on task_judgement. */
	judgementSource?: JudgementSource;
	/** Optional 0..1 task score; only on task_judgement. */
	taskScore?: number;
	/** Benchmark identity supplied by a labelled judgement source. */
	runId?: string;
	caseId?: string;
	/** Optional grader provenance; only on task_judgement. Kept directly on the
	 *  row so a grade is never left unattributed even if a sibling provenance
	 *  ledger write fails (BUG: attribution silently lost otherwise). */
	reviewerId?: string;
	rubricVersion?: string;
	evidenceRef?: string;
}
