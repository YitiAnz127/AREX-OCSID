/**
 * Deterministic pilot skill selection (Step 2 helper).
 *
 * Selects a small, stratified pilot set from the full repository-skill list so
 * the frozen benchmark covers a diversity of skill "shapes" without sampling
 * bias. Selection is **seeded and deterministic** — the same inputs always
 * produce the same set, which is required for a frozen held-out split.
 */

export type SkillCategory = "executable" | "tool_driven" | "workflow" | "reference";

export interface SkillProfile {
	skillId: string;
	category: SkillCategory;
}

/** Deterministic 32-bit FNV-1a hash used as a seed per skill. */
function fnv1a(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Pick `target` skills (default 10, clamped 8..12) stratified by category,
 * seeded by `seed`. Within each category, skills are ordered deterministically
 * then spaced out (round-robin by hash) so the pilot is not dominated by
 * alphabetically-first skills.
 */
export function selectPilotSkills(profiles: SkillProfile[], options?: { target?: number; seed?: string }): string[] {
	const target = Math.min(12, Math.max(8, options?.target ?? 10));
	const seed = options?.seed ?? "pilot-1";
	const byCategory = new Map<SkillCategory, SkillProfile[]>();
	for (const profile of profiles) {
		const list = byCategory.get(profile.category) ?? [];
		list.push(profile);
		byCategory.set(profile.category, list);
	}
	const order: SkillCategory[] = ["executable", "tool_driven", "workflow", "reference"];
	// Per-category deterministic ordering: alternate is not needed; we spread via
	// the global hash-keyed ordering below, but keep category balance.
	const pool: SkillProfile[] = [];
	const categoriesPresent = order.filter((c) => byCategory.has(c) && (byCategory.get(c)!.length ?? 0) > 0);
	// Round-robin across categories so every present category contributes.
	const perCategory = categoriesPresent.map((c) => {
		// deterministic within category
		return [...(byCategory.get(c) ?? [])].sort((a, b) => fnv1a(seed + ":" + a.skillId) - fnv1a(seed + ":" + b.skillId));
	});
	let idx = 0;
	while (pool.length < target) {
		let added = false;
		for (const list of perCategory) {
			if (idx < list.length) {
				pool.push(list[idx]);
				added = true;
				if (pool.length >= target) break;
			}
		}
		if (!added) break;
		idx += 1;
	}
	// Final deterministic order by hash.
	return pool.map((p) => p.skillId).sort((a, b) => fnv1a(seed + ":final:" + a) - fnv1a(seed + ":final:" + b));
}
