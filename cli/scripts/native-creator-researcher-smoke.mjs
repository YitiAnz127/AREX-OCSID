#!/usr/bin/env node
/**
 * P1-03 end-to-end smoke: a real native Creator→Researcher session pair.
 *
 * It runs the *built* CLI (`dist/cli.js`), which spawns real child sessions that
 * drive real tools in a real workspace, against the deterministic local
 * Responses-API double in `mock-openai-responses.mjs`. Nothing here touches the
 * network or a paid provider, so the Creator→Researcher path can be re-verified
 * on any machine (and in CI) even when the outbound proxy is down.
 *
 * Asserted chain:
 *   1. Creator phase writes a SKILL.md package.
 *   2. Researcher phase runs the ad-hoc case in an isolated workspace and is
 *      graded by an independent workspace verifier (`ocsid.workspace-verifier.v1`).
 *   3. The run persists a quality-ledger row and workspace evidence (P1-02).
 *   4. `verify-archive` replays the archived verdict after the workspace is gone.
 *
 * Usage (from `cli/`, after `npm run build`):
 *   node scripts/native-creator-researcher-smoke.mjs [--keep]
 *
 * Every artefact lives in a temp directory (including a throwaway
 * `OCSID_CODING_AGENT_DIR`), so the smoke never writes into the developer's
 * `~/.ocsid` state. Exit code 0 means the whole chain held.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(scriptsDir, "..");
const cliEntry = path.join(cliDir, "dist", "cli.js");
const mockEntry = path.join(scriptsDir, "mock-openai-responses.mjs");
const keep = process.argv.includes("--keep");

if (!existsSync(cliEntry)) {
	process.stderr.write(`build the CLI first: ${cliEntry} is missing (run "npm run build" in ${cliDir})\n`);
	process.exit(2);
}

const root = mkdtempSync(path.join(tmpdir(), "ocsid-native-e2e-"));
const sourceDir = path.join(root, "source-repo");
const outDir = path.join(root, "out");
const caseDir = path.join(root, "case");
const agentDir = path.join(root, "agent");
for (const dir of [sourceDir, outDir, caseDir, agentDir]) mkdirSync(dir, { recursive: true });

// A tiny stand-in for a repository the Creator phase must distil.
writeFileSync(
	path.join(sourceDir, "README.md"),
	"# tiny-mock-repo\n\nA minimal repository used by the P1-03 end-to-end smoke.\n",
	"utf8",
);
writeFileSync(path.join(sourceDir, "routing.py"), "def route(package):\n    return package.split('/')[0]\n", "utf8");

const userRequest = [
	"Produce a short markdown brief that explains how this repository routes a package name",
	"to its owning project, and write it to output/answer.md.",
	"",
].join("\n");
writeFileSync(path.join(caseDir, "user_request.txt"), userRequest, "utf8");
writeFileSync(
	path.join(caseDir, "assertions.json"),
	`${JSON.stringify({ schema: "ocsid.usability-case.v1", assertions: ["Mentions the routing function", "Is markdown"] }, null, 2)}\n`,
	"utf8",
);
// The independent verifier: the model never sees it, and it decides the score.
writeFileSync(
	path.join(caseDir, "verifier.json"),
	`${JSON.stringify({ schema: "ocsid.workspace-verifier.v1", checks: [{ type: "file-exists", path: "output/answer.md" }] }, null, 2)}\n`,
	"utf8",
);

const runId = `smoke-native-${Date.now().toString(36)}`;

// The sessions are launched by the CLI under test, and a session started with a
// completely empty agent directory never reaches the provider: it hangs on
// first-run plugin/npm bootstrap and produces no stream at all (measured with a
// spawn probe, 2026-10-03). So the temp agent directory links the operator's
// installed runtime (`bin`, `npm`, `skills`) and copies its config files, while
// its `rsi/` state stays isolated.
const realAgentDir = path.join(homedir(), ".ocsid", "agent");
const copiedConfig = [];
const linkedRuntime = [];
if (existsSync(realAgentDir)) {
	for (const name of readdirSync(realAgentDir)) {
		const source = path.join(realAgentDir, name);
		if (name.endsWith(".json")) {
			copyFileSync(source, path.join(agentDir, name));
			copiedConfig.push(name);
			continue;
		}
		if (!["bin", "npm", "skills"].includes(name)) continue;
		try {
			symlinkSync(source, path.join(agentDir, name), "junction");
			linkedRuntime.push(name);
		} catch (error) {
			process.stdout.write(`WARN  could not link ${name} into the throwaway agent dir: ${error instanceof Error ? error.message : error}\n`);
		}
	}
}
process.stdout.write(`agent config copied into the throwaway agent dir: ${copiedConfig.join(", ") || "(none found)"}\n`);
process.stdout.write(`agent runtime linked into the throwaway agent dir: ${linkedRuntime.join(", ") || "(none found)"}\n`);
const failures = [];
const check = (label, ok, detail = "") => {
	process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}\n`);
	if (!ok) failures.push(label);
};

/** Start the Responses-API double and resolve with its base URL. */
function startMockProvider() {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [mockEntry, "--port=0"], { stdio: ["ignore", "pipe", "inherit"] });
		let buffer = "";
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const match = /MOCK_OPENAI_RESPONSES_URL=(\S+)/.exec(buffer);
			if (match) resolve({ child, url: match[1] });
		});
		child.on("error", reject);
		child.on("exit", (code) => reject(new Error(`mock provider exited early (code ${code})`)));
	});
}

function runCli(args, env) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cliEntry, ...args], {
			cwd: cliDir,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
		child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

const mock = await startMockProvider();
const env = {
	OCSID_CODING_AGENT_DIR: agentDir,
	AZURE_OPENAI_BASE_URL: mock.url,
	AZURE_OPENAI_API_KEY: "mock",
	AZURE_OPENAI_API_VERSION: "v1",
};

try {
	const created = await runCli(
		[
			"repo-skills", "creator-researcher",
			"--source", sourceDir,
			"--out", outDir,
			"--skill", "mock-skill",
			"--request", path.join(caseDir, "user_request.txt"),
			"--assertions", path.join(caseDir, "assertions.json"),
			"--verifier", path.join(caseDir, "verifier.json"),
			"--run", runId,
			"--provider", "azure-openai-responses",
			"--model", "gpt-4.1",
			"--wall-ms", "120000",
			"--token-budget", "500000",
		],
		env,
	);
	if (created.code !== 0) {
		process.stdout.write(created.stdout);
		process.stderr.write(created.stderr);
	}
	check("creator-researcher exits 0", created.code === 0, `exit ${created.code}`);
	check("Creator phase wrote SKILL.md", existsSync(path.join(outDir, "mock-skill", "SKILL.md")));
	check(
		"Creator SKILL.md carries the requested name",
		existsSync(path.join(outDir, "mock-skill", "SKILL.md")) &&
			/\nname: mock-skill\n/.test(`\n${readFileSync(path.join(outDir, "mock-skill", "SKILL.md"), "utf8")}\n`),
	);
	check("Researcher run is labelled native-agent-eval", /runKind: native-agent-eval/.test(created.stdout));

	const runDir = path.join(agentDir, "rsi", "quality", "audit", runId);
	const ledgerPath = path.join(runDir, "ledger.jsonl");
	const ledgerRows = existsSync(ledgerPath)
		? readFileSync(ledgerPath, "utf8").split("\n").filter((line) => line.trim().length > 0)
		: [];
	const row = ledgerRows[0] ? JSON.parse(ledgerRows[0]) : undefined;
	const summary = existsSync(path.join(runDir, "summary.json"))
		? JSON.parse(readFileSync(path.join(runDir, "summary.json"), "utf8"))
		: {};
	const note = typeof summary.note === "string" ? summary.note : "";
	check(
		"Researcher session identity is recorded",
		summary.kind === "native-agent-eval" &&
			/runtime=native-session/.test(note) &&
			/nativeSession=\S+ mode=researcher runtime=\S+\/\S+/.test(note),
		note.trim().split("; ").slice(0, 2).join("; "),
	);
	const evidencePath = path.join(runDir, "workspace-evidence.json");
	const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, "utf8")) : {};
	const verifierSha256 = String(evidence?.verifier?.sha256 ?? "");
	check(
		"run is graded by the workspace verifier",
		row?.gradedBy === "assertion" && /^[0-9a-f]{64}$/.test(verifierSha256),
		`gradedBy=${String(row?.gradedBy)} verifier sha256=${verifierSha256.slice(0, 12)}…`,
	);
	check("quality ledger records exactly one graded row", ledgerRows.length === 1, `${ledgerRows.length} row(s)`);
	check("graded row scores 1 (verifier passed)", row?.score === 1, `score=${String(row?.score)}`);
	check("workspace evidence was archived (P1-02)", existsSync(evidencePath));
	check("native session stream was archived", existsSync(path.join(runDir, "native-researcher-session.jsonl")));
	check(
		"the graded response was hidden from the operator's tree",
		!existsSync(path.join(outDir, "mock-skill", "output")),
	);

	const replay = await runCli(["repo-skills", "verify-archive", "--run", runId], env);
	check("verify-archive replays the archived verdict", replay.code === 0 && /REPLAY MATCHES/.test(replay.stdout), `exit ${replay.code}`);
	if (replay.code !== 0) process.stdout.write(replay.stdout + replay.stderr);

	// A native child must stop inside its own agent loop, before another tool or
	// provider call, when the shared episode has only a tiny allowance left.
	const limitedRunId = `${runId}-budget`;
	const limited = await runCli([
		"repo-skills", "audit", "--executor", "native", "--run", limitedRunId,
		"--benchmark", path.resolve(cliDir, "..", "skills", "tests", "benchmark-v2"),
		"--skill", "mock-skill", "--skill-root", outDir,
		"--request", path.join(caseDir, "user_request.txt"),
		"--verifier", path.join(caseDir, "verifier.json"),
		"--agent-provider", "azure-openai-responses", "--agent-model", "gpt-4.1",
		"--token-budget", "1", "--wall-ms", "20000",
	], env);
	const limitedEvidencePath = path.join(agentDir, "rsi", "quality", "audit", limitedRunId, "diagnostic-evidence.json");
	const limitedEvidence = existsSync(limitedEvidencePath) ? JSON.parse(readFileSync(limitedEvidencePath, "utf8")) : {};
	if (!/native session exhausted tokenBudget/.test(limited.stdout + limited.stderr)) {
		process.stdout.write(limited.stdout + limited.stderr);
	}
	check("native budget guard stops inside the child session", /native session exhausted tokenBudget/.test(limited.stdout + limited.stderr));
	check("budget-exhausted native run cannot provide an acceptance score", limitedEvidence.executionStatus === "failed" && limitedEvidence.score === null);
} finally {
	mock.child.kill();
	if (keep) {
		process.stdout.write(`\nkept: ${root}\nrun dir: ${path.join(agentDir, "rsi", "quality", "audit", runId)}\n`);
	} else {
		rmSync(root, { recursive: true, force: true });
	}
}

process.stdout.write(
	failures.length === 0
		? "\nP1-03 native Creator→Researcher smoke: PASS (deterministic local provider; link evidence, not a model-quality claim).\n"
		: `\nP1-03 native Creator→Researcher smoke: FAIL (${failures.join("; ")})\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
