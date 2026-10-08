#!/usr/bin/env node
/**
 * Gate for the Python workflow skills shipped inside the OCSID package
 * (`packages/coding-agent/src/ocsid/skills/**`).
 *
 * Those skills carry real pytest suites and real runtime scripts, but nothing in
 * the release pipeline used to run them (P2-02 in the 2026-10-03 closure
 * review). This gate runs them and, importantly, refuses to look green when it
 * could not run at all: a "not run" is reported as a failure, never as a pass.
 *
 * Interpreter resolution order:
 *   1. $OCSID_PYTHON            (explicit override, for CI)
 *   2. python3 / python / py -3 (each must import pytest)
 *
 * Usage:
 *   node scripts/verify-workflow-skills.mjs [--json]
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillsRoot = join(packageRoot, "packages", "coding-agent", "src", "ocsid", "skills");
const json = process.argv.slice(2).includes("--json");

const candidates = [];
if (process.env.OCSID_PYTHON) candidates.push({ command: process.env.OCSID_PYTHON, args: [] });
candidates.push({ command: "python3", args: [] }, { command: "python", args: [] }, { command: "py", args: ["-3"] });

function probe(candidate) {
	const result = spawnSync(candidate.command, [...candidate.args, "-c", "import pytest, sys; print(sys.executable)"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) return undefined;
	const executable = (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop();
	return executable ? { ...candidate, executable } : undefined;
}

const interpreter = candidates.map(probe).find(Boolean);

function report(failures, note) {
	if (json) {
		process.stdout.write(`${JSON.stringify({ gate: "workflow-skills", skillsRoot, ran: note.ran, failures }, null, 2)}\n`);
	} else {
		process.stdout.write(`${note.headline}\n`);
		for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
	}
	process.exit(failures.length === 0 ? 0 : 1);
}

if (!interpreter) {
	report(
		[
			"no Python interpreter with pytest was found; the workflow skill suites did NOT run",
			process.env.OCSID_PYTHON
				? `OCSID_PYTHON=${process.env.OCSID_PYTHON} could not import pytest`
				: "tried python3, python, py -3 — set OCSID_PYTHON to a pytest-capable interpreter",
		],
		{
			ran: false,
			headline: "WORKFLOW SKILL GATE DID NOT RUN (this is not a pass).",
		},
	);
}

const args = [...interpreter.args, "-m", "pytest", skillsRoot, "-q"];
const run = spawnSync(interpreter.command, args, { cwd: packageRoot, stdio: "inherit" });

if (run.error) {
	report([`pytest could not be started: ${run.error.message}`], { ran: true, headline: "WORKFLOW SKILL GATE FAILED." });
}
if (run.status !== 0) {
	report([`pytest exited with code ${run.status ?? "unknown"} (${interpreter.executable})`], {
		ran: true,
		headline: "WORKFLOW SKILL GATE FAILED.",
	});
}

report([], { ran: true, headline: `WORKFLOW SKILL GATE PASSED (${interpreter.executable}).` });
