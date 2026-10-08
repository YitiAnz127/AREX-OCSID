import { describe, expect, it } from "vitest";
import { isSkillEligibleForOcsidMode, resolveOcsidSkillRole } from "./skill-policy.ts";
import { DEFAULT_OCSID_AGENT_MODE, parseOcsidAgentModeCommand, resolveOcsidAgentMode } from "./types.ts";

describe("OCSID mode resolution", () => {
	it("defaults missing and invalid values to Researcher", () => {
		expect(resolveOcsidAgentMode(undefined)).toEqual({ mode: DEFAULT_OCSID_AGENT_MODE });
		expect(resolveOcsidAgentMode("legacy")).toEqual({ mode: "researcher", invalidValue: "legacy" });
		expect(resolveOcsidAgentMode(null)).toEqual({ mode: "researcher", invalidValue: null });
	});

	it("accepts only the two exact mode values", () => {
		expect(resolveOcsidAgentMode("creator")).toEqual({ mode: "creator" });
		expect(resolveOcsidAgentMode("researcher")).toEqual({ mode: "researcher" });
		expect(resolveOcsidAgentMode("Creator").mode).toBe("researcher");
	});

	it("parses only canonical mode commands and reports arguments", () => {
		expect(parseOcsidAgentModeCommand("/creator")).toEqual({ mode: "creator", hasArguments: false });
		expect(parseOcsidAgentModeCommand("/researcher task")).toEqual({ mode: "researcher", hasArguments: true });
		expect(parseOcsidAgentModeCommand("/resarcher")).toBeUndefined();
		expect(parseOcsidAgentModeCommand("/creator-extra")).toBeUndefined();
	});
});

describe("OCSID skill role policy", () => {
	it("treats an absent role as operating without an invalid-value diagnostic", () => {
		expect(resolveOcsidSkillRole({})).toEqual({ role: "operating" });
		expect(resolveOcsidSkillRole({ metadata: {} })).toEqual({ role: "operating" });
		expect(resolveOcsidSkillRole({ metadata: "external metadata" })).toEqual({ role: "operating" });
	});

	it("accepts only exact meta, operating, and shared values", () => {
		expect(resolveOcsidSkillRole({ metadata: { "ocsid-role": "meta" } })).toEqual({ role: "meta" });
		expect(resolveOcsidSkillRole({ metadata: { "ocsid-role": "operating" } })).toEqual({ role: "operating" });
		expect(resolveOcsidSkillRole({ metadata: { "ocsid-role": "shared" } })).toEqual({ role: "shared" });

		for (const invalidValue of ["", "Meta", "researcher", "both", null, false, 1, []]) {
			expect(resolveOcsidSkillRole({ metadata: { "ocsid-role": invalidValue } })).toEqual({ invalidValue });
		}
	});

	it("exposes shared to both modes while preserving exclusive roles", () => {
		expect(isSkillEligibleForOcsidMode("meta", "creator")).toBe(true);
		expect(isSkillEligibleForOcsidMode("meta", "researcher")).toBe(false);
		expect(isSkillEligibleForOcsidMode("operating", "creator")).toBe(false);
		expect(isSkillEligibleForOcsidMode("operating", "researcher")).toBe(true);
		expect(isSkillEligibleForOcsidMode("shared", "creator")).toBe(true);
		expect(isSkillEligibleForOcsidMode("shared", "researcher")).toBe(true);
	});
});
