import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizePath } from "./paths.ts";

const localFileUrl = pathToFileURL(join(tmpdir(), "notes.md")).href;

describe("normalizePath file:// handling", () => {
	it("accepts a local file:// URL with no host", () => {
		const resolved = normalizePath(localFileUrl);
		expect(resolved).toContain("notes.md");
		expect(resolved).not.toContain("file://");
	});

	it("accepts an explicit localhost host", () => {
		const withLocalhost = new URL(localFileUrl);
		withLocalhost.hostname = "localhost";
		expect(normalizePath(withLocalhost.href)).toContain("notes.md");
	});

	it("refuses a file:// URL naming a remote host (SMB/NTLM disclosure on Windows)", () => {
		// On Windows this used to become \\attacker.example\share\notes.md and
		// open an SMB session to the attacker before returning any content.
		expect(() => normalizePath("file://attacker.example/share/notes.md")).toThrow(/remote host/i);
		expect(() => normalizePath("file://169.254.169.254/share/x")).toThrow(/remote host/i);
	});

	it("refuses a malformed file:// URL instead of passing it through", () => {
		expect(() => normalizePath("file://")).toThrow();
	});

	it("leaves ordinary and UNC-style plain paths untouched", () => {
		expect(normalizePath("./a/b.md")).toBe("./a/b.md");
		expect(normalizePath("C:\\work\\notes.md")).toBe("C:\\work\\notes.md");
	});
});
