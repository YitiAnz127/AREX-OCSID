import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFetchableUrl, guardedFetch, isBlockedAddress, type HostResolver } from "./url-guard.ts";

/** Every name answers with a public address unless a test overrides it. */
const publicResolver: HostResolver = async () => [{ address: "93.184.216.34" }];

function resolverFor(map: Record<string, string[]>): HostResolver {
	return async (hostname) => {
		const addresses = map[hostname];
		if (!addresses) throw new Error("ENOTFOUND");
		return addresses.map((address) => ({ address }));
	};
}

const redirectTo = (location: string) =>
	({
		status: 302,
		headers: { get: (name: string) => (name.toLowerCase() === "location" ? location : null) },
	}) as unknown as Response;

describe("isBlockedAddress", () => {
	it("blocks loopback, private, link-local (metadata), CGNAT and reserved IPv4", () => {
		for (const address of [
			"127.0.0.1",
			"127.1.2.3",
			"0.0.0.0",
			"10.0.0.5",
			"172.16.0.1",
			"172.31.255.254",
			"192.168.1.1",
			"169.254.169.254", // AWS/GCP/Azure instance metadata
			"100.64.0.1",
			"198.18.0.1",
			"224.0.0.1",
			"255.255.255.255",
		]) {
			expect(isBlockedAddress(address), address).toBe(true);
		}
	});

	it("allows globally routable IPv4", () => {
		for (const address of ["1.1.1.1", "8.8.8.8", "140.82.121.4", "172.32.0.1", "192.169.0.1"]) {
			expect(isBlockedAddress(address), address).toBe(false);
		}
	});

	it("blocks IPv6 loopback, ULA, link-local, multicast and IPv4-mapped private", () => {
		for (const address of [
			"::1",
			"::",
			"fc00::1",
			"fd12:3456::1",
			"fe80::1",
			"ff02::1",
			"::ffff:127.0.0.1",
			"::ffff:169.254.169.254",
		]) {
			expect(isBlockedAddress(address), address).toBe(true);
		}
	});

	it("allows globally routable IPv6", () => {
		expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
	});

	it("treats unparseable input as blocked", () => {
		expect(isBlockedAddress("not-an-ip")).toBe(true);
	});
});

describe("assertFetchableUrl", () => {
	it("rejects non-http(s) schemes", async () => {
		for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/html,<b>", "gopher://example.com/"]) {
			await expect(assertFetchableUrl(url, publicResolver), url).rejects.toThrow(/only http:\/\/ and https:\/\//);
		}
	});

	it("rejects the cloud metadata endpoint", async () => {
		await expect(
			assertFetchableUrl("http://169.254.169.254/latest/meta-data/iam/security-credentials/", publicResolver),
		).rejects.toThrow(/reserved|link-local|private/i);
	});

	it("rejects loopback by literal, by name, and in IPv6 form", async () => {
		await expect(assertFetchableUrl("http://127.0.0.1:53692/callback", publicResolver)).rejects.toThrow(
			/reserved|loopback/i,
		);
		await expect(assertFetchableUrl("http://localhost:8080/admin", publicResolver)).rejects.toThrow(/local hostname/i);
		await expect(assertFetchableUrl("http://[::1]:8080/", publicResolver)).rejects.toThrow(/reserved|loopback/i);
	});

	it("rejects private-range literals and local suffixes", async () => {
		await expect(assertFetchableUrl("http://10.0.0.1/", publicResolver)).rejects.toThrow(/reserved|private/i);
		await expect(assertFetchableUrl("http://192.168.0.1/", publicResolver)).rejects.toThrow(/reserved|private/i);
		await expect(assertFetchableUrl("http://metadata.google.internal/computeMetadata/v1/", publicResolver)).rejects.toThrow(
			/local hostname/i,
		);
	});

	it("rejects a public name that resolves to a private address (DNS-based SSRF)", async () => {
		const resolver = resolverFor({ "evil.example": ["169.254.169.254"] });
		await expect(assertFetchableUrl("http://evil.example/", resolver)).rejects.toThrow(/non-public address/i);
	});

	it("rejects when any single answer is private (split-answer rebinding)", async () => {
		const resolver = resolverFor({ "mixed.example": ["93.184.216.34", "127.0.0.1"] });
		await expect(assertFetchableUrl("http://mixed.example/", resolver)).rejects.toThrow(/non-public address/i);
	});

	it("rejects a name with no addresses", async () => {
		await expect(assertFetchableUrl("http://nx.example/", resolverFor({}))).rejects.toThrow(/could not resolve/i);
	});

	it("rejects URLs carrying embedded credentials", async () => {
		await expect(assertFetchableUrl("https://user:pass@example.com/", publicResolver)).rejects.toThrow(/credentials/i);
	});

	it("rejects malformed input", async () => {
		await expect(assertFetchableUrl("not a url", publicResolver)).rejects.toThrow(/not a valid absolute URL/);
	});

	it("accepts a public https URL", async () => {
		const parsed = await assertFetchableUrl("https://example.com/path?q=1", publicResolver);
		expect(parsed.hostname).toBe("example.com");
	});
});

describe("guardedFetch", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("refuses a redirect that points at the metadata endpoint", async () => {
		// The first URL is public and approved; the 302 is what would reach inward.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectTo("http://169.254.169.254/latest/meta-data/")),
		);

		await expect(guardedFetch("https://example.com/", {}, publicResolver)).rejects.toThrow(/reserved|link-local/i);
	});

	it("refuses a relative redirect that climbs into loopback", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => redirectTo("//127.0.0.1:8080/admin")));

		await expect(guardedFetch("https://example.com/", {}, publicResolver)).rejects.toThrow(/reserved|loopback/i);
	});

	it("follows a redirect that stays public and returns the final response", async () => {
		const final = { status: 200, headers: { get: () => null } } as unknown as Response;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(redirectTo("https://example.com/next"))
			.mockResolvedValueOnce(final);
		vi.stubGlobal("fetch", fetchMock);

		await expect(guardedFetch("https://example.com/", {}, publicResolver)).resolves.toBe(final);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("never asks fetch to follow redirects itself", async () => {
		const fetchMock = vi.fn(async () => ({ status: 200, headers: { get: () => null } }) as unknown as Response);
		vi.stubGlobal("fetch", fetchMock);

		await guardedFetch("https://example.com/", {}, publicResolver);

		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
	});

	it("stops after the redirect limit", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => redirectTo("https://example.com/loop")));

		await expect(guardedFetch("https://example.com/", {}, publicResolver)).rejects.toThrow(/more than 5 redirects/);
	});
});
