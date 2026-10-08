import { describe, expect, it } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("theme global isolation", () => {
	it("initializes only the OCSID global symbol", () => {
		const globals = globalThis as Record<symbol, unknown>;
		const ocsidKey = Symbol.for("@arex-skill/disco:theme");
		const piKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
		const legacyPiKey = Symbol.for("@mariozechner/pi-coding-agent:theme");
		const previousDisco = globals[ocsidKey];
		const previousPi = globals[piKey];
		const previousLegacyPi = globals[legacyPiKey];
		const piSentinel = { owner: "pi" };
		const legacyPiSentinel = { owner: "legacy-pi" };

		try {
			globals[piKey] = piSentinel;
			globals[legacyPiKey] = legacyPiSentinel;
			initTheme("dark");

			expect(globals[ocsidKey]).toBeDefined();
			expect(globals[piKey]).toBe(piSentinel);
			expect(globals[legacyPiKey]).toBe(legacyPiSentinel);
		} finally {
			if (previousDisco === undefined) delete globals[ocsidKey];
			else globals[ocsidKey] = previousDisco;
			if (previousPi === undefined) delete globals[piKey];
			else globals[piKey] = previousPi;
			if (previousLegacyPi === undefined) delete globals[legacyPiKey];
			else globals[legacyPiKey] = previousLegacyPi;
		}
	});
});
