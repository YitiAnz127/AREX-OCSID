import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/index.ts";
import { quoteShellArg } from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

/**
 * A file whose *name* contains shell metacharacters, and whose first line is
 * larger than the read tool's byte limit, makes the tool emit its
 * "use bash: sed -n ... <path> ..." hint. That hint lands in the model's
 * context as a runnable command, so the path must be quoted as one shell word —
 * otherwise a repository can name a file so the hint carries an injected
 * command segment that runs when the model follows it.
 */
const NASTY_NAME = `x';touch pwned;#.txt`;

let workspace: string;
let readTool: ReturnType<typeof createReadTool>;

beforeAll(() => {
	workspace = mkdtempSync(join(tmpdir(), "read-hint-"));
	// One line longer than the limit so `firstLineExceedsLimit` is taken.
	writeFileSync(join(workspace, NASTY_NAME), `${"A".repeat(DEFAULT_MAX_BYTES + 1)}\nsecond\n`);
	readTool = createReadTool(workspace);
});

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true });
});

describe("quoteShellArg", () => {
	it("wraps a plain value in single quotes", () => {
		expect(quoteShellArg("notes.md")).toBe("'notes.md'");
	});

	it("neutralizes metacharacters by leaving them literal", () => {
		expect(quoteShellArg("a;b")).toBe("'a;b'");
		expect(quoteShellArg("$(whoami)")).toBe("'$(whoami)'");
		expect(quoteShellArg("a b")).toBe("'a b'");
	});

	it("escapes an embedded single quote so it cannot close the quoting", () => {
		expect(quoteShellArg("it's")).toBe("'it'\\''s'");
	});

	it("keeps a full injected payload as one literal word", () => {
		expect(quoteShellArg(NASTY_NAME)).toBe("'x'\\'';touch pwned;#.txt'");
	});
});

describe("read tool truncation hint", () => {
	it("quotes the path so the suggested command cannot be injected into", async () => {
		const result = await readTool.execute("hint-1", { path: NASTY_NAME });
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(text).toContain("Use bash:");
		// The metacharacters must sit inside single quotes, not at shell level.
		expect(text).toContain(quoteShellArg(NASTY_NAME));
		expect(text).not.toContain(` ${NASTY_NAME} `);
		// The raw unquoted form would have opened a quote and injected `touch pwned`.
		expect(text).not.toMatch(/sed -n '\d+p' x';touch/);
	});
});
