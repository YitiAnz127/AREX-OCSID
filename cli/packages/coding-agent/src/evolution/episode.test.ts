/** P1-04: the episode state machine, budget ledger and stop conditions. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EPISODE_SCHEMA,
	appendEpisodeLog,
	canTransition,
	chargeEpisodeBudget,
	createEpisode,
	defaultEpisodeBudget,
	episodeBudgetStop,
	episodeDir,
	episodeLogPath,
	episodeStatePath,
	readEpisode,
	recordEpisodeStep,
	saveEpisode,
	stopEpisode,
	transitionEpisode,
} from "./episode.ts";

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ocsid-episode-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function open(): ReturnType<typeof createEpisode> {
	return createEpisode({ qualityDir: root, episodeId: "ep-1", skillId: "skill-a", caseId: "case-1" });
}

describe("RSI episode state machine", () => {
	it("opens an episode on disk and reads the identical state back", () => {
		const created = open();
		expect(created.schema).toBe(EPISODE_SCHEMA);
		expect(created.phase).toBe("evidence");
		expect(created.budget).toEqual(defaultEpisodeBudget());
		expect(fs.existsSync(episodeStatePath(root, "ep-1"))).toBe(true);
		expect(episodeDir(root, "ep-1")).toBe(path.join(root, "episodes", "ep-1"));
		expect(readEpisode(root, "ep-1")).toEqual(created);
	});

	it("refuses to reuse an episode id and rejects a corrupted state file", () => {
		open();
		expect(() => open()).toThrow(/episode already exists/);
		fs.writeFileSync(episodeStatePath(root, "ep-1"), JSON.stringify({ schema: EPISODE_SCHEMA, episodeId: "ep-1", skillId: "skill-a", caseId: "case-1", phase: "applied" }), "utf8");
		expect(() => readEpisode(root, "ep-1")).toThrow(/unknown phase applied/);
		expect(() => readEpisode(root, "missing")).toThrow(/episode not found/);
	});

	it("allows only the declared transitions and blocks everything out of a terminal phase", () => {
		expect(canTransition("evidence", "probe")).toBe(true);
		expect(canTransition("evidence", "promotion")).toBe(false);
		expect(canTransition("awaiting-approval", "promotion")).toBe(true);
		expect(canTransition("awaiting-approval", "abstained")).toBe(true);
		expect(canTransition("verified", "promotion")).toBe(false);
		let state = open();
		state = transitionEpisode(state, "probe");
		expect(state.phase).toBe("probe");
		expect(() => transitionEpisode(state, "promotion")).toThrow(/illegal episode transition probe -> promotion/);
		const rejected = stopEpisode(transitionEpisode(state, "diagnosis"), "abstain", "U0 said probe");
		expect(rejected.phase).toBe("abstained");
		expect(rejected.stop).toMatchObject({ kind: "abstain", reason: "U0 said probe" });
		expect(() => transitionEpisode(rejected, "candidate")).toThrow(/terminal: true/);
	});

	it("maps stop kinds onto terminal phases and survives a round trip", () => {
		const state = open();
		expect(stopEpisode(state, "failure", "probe error").phase).toBe("failed");
		expect(stopEpisode(state, "budget", "token budget spent").phase).toBe("abstained");
		expect(stopEpisode(state, "completed", "promoted").phase).toBe("verified");
		const saved = saveEpisode(root, stopEpisode(recordEpisodeStep(state, { step: "probe", status: "succeeded", detail: "2 pairs" }), "abstain", "non-skill"));
		expect(saved.steps.find((step) => step.step === "probe")).toMatchObject({ status: "succeeded", detail: "2 pairs" });
		expect(readEpisode(root, "ep-1").stop?.reason).toBe("non-skill");
	});

	it("charges the shared budget and names the exhausted resource", () => {
		let state = open();
		expect(episodeBudgetStop(state)).toBeUndefined();
		state = chargeEpisodeBudget(state, { probePairs: 2, wallMs: 1_000, tokens: 100 });
		expect(state.budget).toMatchObject({ probePairs: 2, wallMs: 1_000, tokens: 100 });
		expect(episodeBudgetStop(state)).toBeUndefined();
		expect(episodeBudgetStop(chargeEpisodeBudget(state, { probePairs: 2 }))).toMatch(/probe budget spent \(4\/4 paired probes\)/);
		expect(episodeBudgetStop(chargeEpisodeBudget(state, { candidates: 1 }))).toMatch(/candidate budget spent/);
		expect(episodeBudgetStop(chargeEpisodeBudget(state, { wallMs: 30 * 60_000 }))).toMatch(/wall-time budget spent/);
		expect(episodeBudgetStop(chargeEpisodeBudget(state, { tokens: 400_000 }))).toMatch(/token budget spent/);
	});

	it("writes an append-only episode log next to the state", () => {
		const state = transitionEpisode(open(), "probe");
		appendEpisodeLog(root, state, { step: "probe", at: new Date().toISOString(), status: "started", detail: "2 pairs" });
		const lines = fs.readFileSync(episodeLogPath(root, "ep-1"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toMatchObject({ episodeId: "ep-1", phase: "probe", step: "probe", status: "started" });
	});

	it("rejects non-canonical ids before they reach the filesystem", () => {
		expect(() => createEpisode({ qualityDir: root, episodeId: "Ep 1", skillId: "skill-a", caseId: "case-1" })).toThrow(/episodeId/);
		expect(() => createEpisode({ qualityDir: root, episodeId: "ep-2", skillId: "Skill A", caseId: "case-1" })).toThrow(/skillId/);
		expect(() => createEpisode({ qualityDir: root, episodeId: "ep-3", skillId: "skill-a", caseId: "../escape" })).toThrow(/caseId/);
	});

	it("keeps a content digest of the state stable across re-saves", () => {
		const clock = () => new Date(0);
		const created = createEpisode({ qualityDir: root, episodeId: "ep-1", skillId: "skill-a", caseId: "case-1", now: clock });
		const digestOf = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		const before = digestOf(episodeStatePath(root, "ep-1"));
		saveEpisode(root, created, clock);
		expect(digestOf(episodeStatePath(root, "ep-1"))).toBe(before);
	});
});
