import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalDiscoExperimental = process.env.DISCO_EXPERIMENTAL;

	afterEach(() => {
		if (originalDiscoExperimental === undefined) {
			delete process.env.DISCO_EXPERIMENTAL;
		} else {
			process.env.DISCO_EXPERIMENTAL = originalDiscoExperimental;
		}
	});

	it("returns false when DISCO_EXPERIMENTAL is unset", () => {
		delete process.env.DISCO_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when DISCO_EXPERIMENTAL is empty", () => {
		process.env.DISCO_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when DISCO_EXPERIMENTAL is set to 1", () => {
		process.env.DISCO_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when DISCO_EXPERIMENTAL is set to 0", () => {
		process.env.DISCO_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("accepts the natural 1/true/yes forms and rejects everything else", () => {
		// All DISCO_* toggles are unified on 1/true/yes (case-insensitive). Before
		// that, only the literal "1" worked, so DISCO_EXPERIMENTAL=true was silently
		// ignored while DISCO_OFFLINE=true took effect — the same flag family
		// behaving differently with no diagnostic.
		for (const on of ["1", "true", "TRUE", "True", "yes", "YES"]) {
			process.env.DISCO_EXPERIMENTAL = on;
			expect(areExperimentalFeaturesEnabled(), `DISCO_EXPERIMENTAL=${on}`).toBe(true);
		}
		for (const off of ["0", "false", "no", "on", "2", "enabled"]) {
			process.env.DISCO_EXPERIMENTAL = off;
			expect(areExperimentalFeaturesEnabled(), `DISCO_EXPERIMENTAL=${off}`).toBe(false);
		}
	});
});
