import { describe, expect, it } from "vitest";
import { isEscapingRelative } from "./path-utils";

describe("isEscapingRelative (P0-02 containment)", () => {
	it("returns false for the root itself and contained children", () => {
		expect(isEscapingRelative("")).toBe(false);
		expect(isEscapingRelative("file.txt")).toBe(false);
		expect(isEscapingRelative("src")).toBe(false);
		expect(isEscapingRelative("src/deep/nested.ts")).toBe(false);
	});

	it("returns true for parent escapes", () => {
		expect(isEscapingRelative("..")).toBe(true);
		expect(isEscapingRelative("../outside")).toBe(true);
		expect(isEscapingRelative("src/../../outside")).toBe(true);
	});

	it("returns true for absolute paths (never contained relative to a root)", () => {
		// The input to isEscapingRelative is always the output of path.relative(),
		// i.e. host-native. On POSIX a "C:\..." string is an ordinary RELATIVE
		// filename (backslash is a legal name character), so asserting that it
		// escapes would be wrong there — and dropping it would hide a real result.
		// Only assert the Windows drive forms on Windows.
		if (process.platform === "win32") {
			expect(isEscapingRelative("C:\\evil.txt")).toBe(true);
			expect(isEscapingRelative("C:/evil.txt")).toBe(true);
		}
		// POSIX absolute paths escape on every host (path.isAbsolute is true for
		// them on win32 too).
		expect(isEscapingRelative("/etc/passwd")).toBe(true);
	});

	it("treats a sibling-with-shared-prefix (not a parent escape) as contained", () => {
		// 'outside2' shares the 'outside' prefix but is a genuine in-root child.
		expect(isEscapingRelative("outside2.ts")).toBe(false);
		expect(isEscapingRelative("src/outside.ts")).toBe(false);
	});
});
