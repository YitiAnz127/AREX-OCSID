import { describe, expect, it } from "vitest";
import { getOcsidOAuthCallbackHost } from "./callback-host.ts";

describe("getOcsidOAuthCallbackHost", () => {
	it("defaults to 127.0.0.1 when unset or blank", () => {
		expect(getOcsidOAuthCallbackHost({})).toBe("127.0.0.1");
		expect(getOcsidOAuthCallbackHost({ OCSID_OAUTH_CALLBACK_HOST: "" })).toBe("127.0.0.1");
		expect(getOcsidOAuthCallbackHost({ OCSID_OAUTH_CALLBACK_HOST: "   " })).toBe("127.0.0.1");
	});

	it("accepts loopback literals", () => {
		expect(getOcsidOAuthCallbackHost({ OCSID_OAUTH_CALLBACK_HOST: "127.0.0.1" })).toBe("127.0.0.1");
		expect(getOcsidOAuthCallbackHost({ OCSID_OAUTH_CALLBACK_HOST: "::1" })).toBe("::1");
	});

	it("normalizes a bracketed IPv6 literal to a listenable address", () => {
		expect(getOcsidOAuthCallbackHost({ OCSID_OAUTH_CALLBACK_HOST: "[::1]" })).toBe("::1");
	});

	it("binds localhost to the loopback literal", () => {
		expect(getOcsidOAuthCallbackHost({ OCSID_OAUTH_CALLBACK_HOST: "localhost" })).toBe("127.0.0.1");
	});

	it("refuses a wildcard bind that would expose the callback to the network", () => {
		// 0.0.0.0 means every interface, not localhost: the authorization code
		// would be delivered to whichever host on the network connected first.
		expect(() => getOcsidOAuthCallbackHost({ OCSID_OAUTH_CALLBACK_HOST: "0.0.0.0" })).toThrow(/loopback address/i);
		expect(() => getOcsidOAuthCallbackHost({ OCSID_OAUTH_CALLBACK_HOST: "::" })).toThrow(/loopback address/i);
	});

	it("refuses a routable or LAN address", () => {
		for (const host of ["192.168.1.10", "10.0.0.5", "example.com", "attacker.example"]) {
			expect(() => getOcsidOAuthCallbackHost({ OCSID_OAUTH_CALLBACK_HOST: host }), host).toThrow(/loopback address/i);
		}
	});
});
