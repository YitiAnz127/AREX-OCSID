import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawn(...args) }));

const { openBrowser } = await import("../src/utils/open-browser.ts");

/**
 * The target comes from a provider's auth/device-code response, so a custom or
 * compromised provider (or a MITM'd response) chooses it. Handing that to the
 * OS handler without a scheme check means `file:`, a UNC path, or a leading "-"
 * opens or executes local content instead of a web page.
 */
describe("openBrowser", () => {
	beforeEach(() => {
		spawn.mockReset();
		spawn.mockReturnValue({ on: () => ({ unref: () => {} }) });
	});

	it("opens an https URL", () => {
		openBrowser("https://auth.example/authorize?x=1");
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("opens an http URL", () => {
		openBrowser("http://localhost:1455/auth/callback");
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("refuses non-http schemes that would open local content", () => {
		for (const target of [
			"file:///etc/passwd",
			"file://attacker.example/share/x",
			"\\\\attacker.example\\share\\x",
			"javascript:alert(1)",
			"ms-msdt:/id",
		]) {
			openBrowser(target);
			expect(spawn, target).not.toHaveBeenCalled();
		}
	});

	it("refuses an option-like target", () => {
		// xdg-open parses a leading "-" as an option rather than a URL.
		openBrowser("--version");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("refuses an empty target", () => {
		openBrowser("");
		expect(spawn).not.toHaveBeenCalled();
	});
});
