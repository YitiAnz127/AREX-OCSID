import { describe, expect, it } from "vitest";
import { getOcsidUserAgent } from "../src/utils/ocsid-user-agent.ts";

describe("getOcsidUserAgent", () => {
	it("formats the OCSID user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getOcsidUserAgent("1.2.3");

		expect(userAgent).toBe(`ocsid/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^ocsid\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
