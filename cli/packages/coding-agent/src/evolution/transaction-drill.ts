/**
 * Step 5 — staging-only rollback DRILL (safe, never touches the live skill tree).
 *
 * The real `RepoSkillsLibraryManager` swap/backup/rollback is private and
 * operates on the live tree, so we cannot (and must not) drive it here. Instead
 * this module replicates the manager's *backup → swap → rollback* semantics on an
 * isolated sandbox directory, proving the promotion transaction contract can
 * correctly restore state. This is the Step 5 "rollback drill" deliverable in its
 * safe form: no live skill file is ever read or written.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { ManagerTransactionAdapter, ApplyResult } from "./transact.ts";

interface DrillFiles {
	[key: string]: string;
}

export interface RollbackDrillResult {
	restored: boolean;
	restoredContent: Record<string, string>;
	notes: string[];
}

function readAll(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	function walk(d: string, rel: string): void {
		for (const entry of readdirSync(d)) {
			const p = path.join(d, entry);
			const r = rel ? `${rel}/${entry}` : entry;
			if (statSync(p).isDirectory()) walk(p, r);
			else out[r] = readFileSync(p, "utf8");
		}
	}
	walk(dir, "");
	return out;
}

/**
 * Run a backup→swap→rollback drill inside a scratch dir. Returns whether the
 * restored content equals the original and what actually got restored.
 */
export function runRollbackDrill(sandbox: string, candidateFiles: DrillFiles): RollbackDrillResult {
	const notes: string[] = [];
	const live = path.join(sandbox, "live");
	const backup = path.join(sandbox, "backup");
	const staged = path.join(sandbox, "staged");
	mkdirSync(live, { recursive: true });

	// 1. seed the "live" tree with original content
	const original: DrillFiles = { "skill.json": JSON.stringify({ id: "chemprop", version: "v1" }), "data.tsv": "a\t1\nb\t2\n" };
	for (const [rel, content] of Object.entries(original)) {
		writeFileSync(path.join(live, rel), content, "utf8");
	}

	// 2. backup the live tree (rename to backup)
	mkdirSync(sandbox, { recursive: true });
	renameSync(live, backup);
	notes.push("backup: live moved to backup");

	// 3. place candidate into staged, then swap staged -> live (as the transaction would)
	mkdirSync(staged, { recursive: true });
	for (const [rel, content] of Object.entries(candidateFiles)) {
		writeFileSync(path.join(staged, rel), content, "utf8");
	}
	renameSync(staged, live);
	notes.push("swap: candidate staged into live");

	// 4. rollback: restore backup -> live
	rmSync(live, { recursive: true, force: true });
	renameSync(backup, live);
	notes.push("rollback: backup restored to live");

	const restoredContent = readAll(live);
	const restored =
		restoredContent["skill.json"] === original["skill.json"] &&
		restoredContent["data.tsv"] === original["data.tsv"] &&
		!existsSync(path.join(live, "candidate.json"));

	return { restored, restoredContent, notes };
}

/**
 * A drill-based transaction adapter: applyPatch swaps a candidate into an
 * isolated sandbox and rollback restores it, exercising the promotion contract
 * without any real manager or live tree. Requires `humanApprovalRef`-equivalent
 * consent via `enable` for symmetry with the transaction gate.
 */
export function createDrillAdapter(opts: { sandbox: string; enable?: boolean }): ManagerTransactionAdapter {
	const initial = opts.enable === true;
	return {
		name: "drill(staging-only)",
		applyPatch(): ApplyResult {
			if (!initial) return { ok: false, reason: "drill adapter not enabled: Step 5 promotion is human-gated and this adapter is for sandbox drills only." };
			const res = runRollbackDrill(opts.sandbox, { "candidate.json": JSON.stringify({ id: "candidate" }) });
			if (!res.restored) return { ok: false, reason: "rollback drill did not restore state." };
			return { ok: true, note: "drill completed and rollback restored the sandbox (no live skill affected)." };
		},
		rollback(): void {
			// drill already rolls back within applyPatch; nothing further needed.
		},
	};
}
