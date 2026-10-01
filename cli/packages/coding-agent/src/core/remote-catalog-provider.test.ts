import { describe, expect, it } from "vitest";
import type { Api, Provider } from "@earendil-works/pi-ai";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";

function makeProvider(id = "test"): Provider {
	return {
		id,
		api: "openai" as Api,
		getModels: () => [],
	} as unknown as Provider;
}

describe("withRemoteCatalog", () => {
	it("returns the provider unchanged when no catalog URL is configured", () => {
		const base = makeProvider("p1");
		const result = withRemoteCatalog(base, undefined);
		expect(result.getModels()).toEqual([]);
	});

	it("throws on a non-https catalog URL (secret-exfiltration gate, F1)", () => {
		expect(() => withRemoteCatalog(makeProvider("p1"), "http://catalog.example.com")).toThrow(/must use https/);
		expect(() => withRemoteCatalog(makeProvider("p1"), "ftp://catalog.example.com")).toThrow(/must use https/);
	});

	it("accepts an https catalog URL without throwing", () => {
		const base = makeProvider("p1");
		expect(() => withRemoteCatalog(base, "https://catalog.example.com")).not.toThrow();
	});

	it("throws on a malformed catalog URL rather than falling through silently", () => {
		expect(() => withRemoteCatalog(makeProvider("p1"), "not a url")).toThrow(TypeError);
	});
});
