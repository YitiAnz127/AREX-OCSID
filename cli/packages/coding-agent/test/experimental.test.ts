import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalOcsidExperimental = process.env.OCSID_EXPERIMENTAL;

	afterEach(() => {
		if (originalOcsidExperimental === undefined) {
			delete process.env.OCSID_EXPERIMENTAL;
		} else {
			process.env.OCSID_EXPERIMENTAL = originalOcsidExperimental;
		}
	});

	it("returns false when OCSID_EXPERIMENTAL is unset", () => {
		delete process.env.OCSID_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when OCSID_EXPERIMENTAL is empty", () => {
		process.env.OCSID_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when OCSID_EXPERIMENTAL is set to 1", () => {
		process.env.OCSID_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when OCSID_EXPERIMENTAL is set to 0", () => {
		process.env.OCSID_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("accepts the natural 1/true/yes forms and rejects everything else", () => {
		// All OCSID_* toggles are unified on 1/true/yes (case-insensitive). Before
		// that, only the literal "1" worked, so OCSID_EXPERIMENTAL=true was silently
		// ignored while OCSID_OFFLINE=true took effect — the same flag family
		// behaving differently with no diagnostic.
		for (const on of ["1", "true", "TRUE", "True", "yes", "YES"]) {
			process.env.OCSID_EXPERIMENTAL = on;
			expect(areExperimentalFeaturesEnabled(), `OCSID_EXPERIMENTAL=${on}`).toBe(true);
		}
		for (const off of ["0", "false", "no", "on", "2", "enabled"]) {
			process.env.OCSID_EXPERIMENTAL = off;
			expect(areExperimentalFeaturesEnabled(), `OCSID_EXPERIMENTAL=${off}`).toBe(false);
		}
	});
});
