/**
 * Deterministic path classifier for repo-skill observation.
 *
 * Turns a tool path / command into a (eventType, skillId, subSkillId) triple
 * WITHOUT guessing model intent. Classification relies entirely on matching the
 * path against the known managed repo-skills root layout (root = the directory
 * that contains `repo-skills/` and `repo-skills-router/`):
 *
 *   root/repo-skills-router/references/index/*        -- router/taxonomy
 *   root/repo-skills/skill-id/SKILL.md                -- skill_root_read
 *   root/repo-skills/skill-id/sub-skills/subid/SKILL.md -- sub_skill_read
 *   root/repo-skills/skill-id/references/**           -- reference_read
 *   root/repo-skills/skill-id/scripts/file            -- script_read (file READ)
 *
 * Note about `script_call`: actually *executing* a script cannot be proven from
 * a read alone; the observer separately flags a `script_call` when a bash tool
 * result references a path under a skill's `scripts/`. This classification
 * module only maps FILE reads (a script-file read => `script_read`); execution
 * is handled in the observer.
 */

import { basename, normalize, sep } from "node:path";

import type { RepoSkillEventType } from "./events.ts";

export interface ClassifiedSkillEvent {
	matched: boolean;
	eventType?: RepoSkillEventType;
	skillId?: string;
	subSkillId?: string;
	kind?: "root" | "sub" | "reference" | "script" | "router" | "taxonomy";
}

function toForward(p: string): string {
	// Normalize BOTH separators, not just the host's. Splitting on `sep` alone made
	// this a no-op on POSIX (`sep` is "/"), so a backslash-form path silently
	// failed to match its root and classifySkillPath reported "unmatched" — the
	// documented Windows-path handling only actually worked on Windows.
	//
	// Treating "\" as a separator everywhere is the right trade here: the inputs
	// are paths compared against a root, not filenames to open, and a POSIX
	// directory literally named with a backslash is pathological next to the real
	// scenario (Windows-style paths in tool arguments).
	return p.replace(/[\\/]+/g, "/");
}

/**
 * Classify an absolute (or normalized forward-slash) file path against the
 * repo-skills root. `repoSkillsRoot` should be the directory that contains both
 * `repo-skills/` and `repo-skills-router/` (i.e. the `skills/repositories`
 * sibling), expressed with forward slashes.
 */
export function classifySkillPath(
	absPath: string,
	repoSkillsRoot: string,
): ClassifiedSkillEvent {
	const path = toForward(normalize(absPath));
	const root = toForward(repoSkillsRoot.replace(/\/+$/, ""));

	// Managed repo skill tree layout.
	const routerSeg = `${root}/repo-skills-router`;
	const skillsSeg = `${root}/repo-skills`;

	if (path.startsWith(routerSeg + "/")) {
		const rel = path.slice(routerSeg.length + 1);
		const lower = rel.toLowerCase();
		if (lower.includes("/index/taxonomy.json") || lower.includes("/index/assignments.jsonl")) {
			return { matched: true, eventType: "taxonomy_read", kind: "taxonomy" };
		}
		return { matched: true, eventType: "router_read", kind: "router" };
	}

	if (path.startsWith(skillsSeg + "/")) {
		const rel = path.slice(skillsSeg.length + 1);
		const segments = rel.split("/").filter(Boolean);
		if (segments.length === 0) return { matched: false };
		const skillId = segments[0];

		// sub-skills/<sub>/.../SKILL.md
		const subIdx = segments.indexOf("sub-skills");
		if (subIdx >= 0 && segments[subIdx + 1]) {
			const subSkillId = segments[subIdx + 1];
			if (basename(normalize(absPath)).toLowerCase() === "skill.md") {
				return { matched: true, eventType: "sub_skill_read", skillId, subSkillId, kind: "sub" };
			}
			if (segments.includes("references")) {
				return {
					matched: true,
					eventType: "reference_read",
					skillId,
					subSkillId,
					kind: "reference",
				};
			}
			return { matched: true, eventType: "reference_read", skillId, subSkillId, kind: "reference" };
		}

		// Root skill
		if (segments.length === 2 && basename(normalize(absPath)).toLowerCase() === "skill.md") {
			return { matched: true, eventType: "skill_root_read", skillId, kind: "root" };
		}
		if (segments.includes("references")) {
			return { matched: true, eventType: "reference_read", skillId, kind: "reference" };
		}
		if (segments.includes("scripts")) {
			// BUG-P1-05: reading a script file proves a READ, not execution.
			return { matched: true, eventType: "script_read", skillId, kind: "script" };
		}
		// Other files inside a skill (README, docs) — a read, but not a classified
		// skill event. We still surface it as reference-like to be safe? No —
		// keep it unclassified to avoid inflating reference metrics.
		return { matched: false };
	}

	return { matched: false };
}
