import type { OcsidAgentMode } from "./types.ts";

export type OcsidSkillRole = "meta" | "operating" | "shared";

export interface OcsidSkillRoleResolution {
	role?: OcsidSkillRole;
	invalidValue?: unknown;
}

function hasOwnKey(value: object, key: PropertyKey): boolean {
	return Object.hasOwn(value, key);
}

export function resolveOcsidSkillRole(frontmatter: Record<string, unknown>): OcsidSkillRoleResolution {
	const metadata = frontmatter.metadata;
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
		return { role: "operating" };
	}

	if (!hasOwnKey(metadata, "ocsid-role")) {
		return { role: "operating" };
	}

	const value = (metadata as Record<string, unknown>)["ocsid-role"];
	if (value === "meta" || value === "operating" || value === "shared") {
		return { role: value };
	}
	return { invalidValue: value };
}

export function isSkillEligibleForOcsidMode(role: OcsidSkillRole, mode: OcsidAgentMode): boolean {
	if (role === "shared") return true;
	return mode === "creator" ? role === "meta" : role === "operating";
}
