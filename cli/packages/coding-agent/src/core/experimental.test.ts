import { describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "./experimental.ts";

// H4: OCSID_* boolean env toggles should accept the same truthy set
// ("1"/"true"/"yes", case-insensitive) as the other OCSID_* flags.
describe("areExperimentalFeaturesEnabled truthy-env coercion (H4)", () => {
	const original = process.env.OCSID_EXPERIMENTAL;
	afterEach(() => {
		if (original === undefined) delete process.env.OCSID_EXPERIMENTAL;
		else process.env.OCSID_EXPERIMENTAL = original;
	});

	it("accepts '1'", () => {
		process.env.OCSID_EXPERIMENTAL = "1";
		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("accepts 'true' (case-insensitive)", () => {
		process.env.OCSID_EXPERIMENTAL = "true";
		expect(areExperimentalFeaturesEnabled()).toBe(true);
		process.env.OCSID_EXPERIMENTAL = "TRUE";
		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("accepts 'yes'", () => {
		process.env.OCSID_EXPERIMENTAL = "yes";
		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("rejects falsy/absent", () => {
		process.env.OCSID_EXPERIMENTAL = "0";
		expect(areExperimentalFeaturesEnabled()).toBe(false);
		delete process.env.OCSID_EXPERIMENTAL;
		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
