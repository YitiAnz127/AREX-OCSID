import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ignoredRulesNotice, relativizeFindResult } from "./find.ts";

// Built with path.join so the fixtures use the host separator, matching what fd
// actually emits on that platform.
const root = path.join(path.sep, "proj", "root");

describe("relativizeFindResult (P0-02 containment)", () => {
	it("relativizes an in-root child to a posix path", () => {
		expect(relativizeFindResult(path.join(root, "a", "b.ts"), root)).toBe("a/b.ts");
	});

	it("drops the search root itself", () => {
		expect(relativizeFindResult(root, root)).toBeNull();
	});

	it("drops a path that escapes the search root", () => {
		expect(relativizeFindResult(path.join(path.sep, "etc", "passwd"), root)).toBeNull();
	});

	it("drops a sibling sharing the root prefix instead of faking an in-root name", () => {
		// Without a separator-boundary check, a raw startsWith() strips by length:
		// "/proj/rootabc/file.ts" against "/proj/root" yields the bogus in-root
		// relative "bc/file.ts" — reporting an out-of-root file as if it were inside.
		const sibling = `${root}abc${path.sep}file.ts`;
		expect(relativizeFindResult(sibling, root)).toBeNull();
	});
});

describe("ignoredRulesNotice (fd < 9 loses .gitignore handling)", () => {
	// A path that cannot be executed: fdSupportsNoRequireGit probes it, gets no
	// version, and reports "unsupported" — which is exactly the fd < 9 branch.
	const OLD_FD = path.join(tmpdir(), "no-such-fd-binary");

	function makeDir(withGitignore: boolean, withGitDir: boolean): string {
		const dir = mkdtempSync(path.join(tmpdir(), "arex-ignore-"));
		if (withGitignore) writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
		if (withGitDir) mkdirSync(path.join(dir, ".git"));
		return dir;
	}

	it("warns when fd cannot apply ignore rules and a .gitignore would be skipped", async () => {
		const dir = makeDir(true, false);
		try {
			expect(await ignoredRulesNotice(OLD_FD, dir)).toMatch(/gitignore rules were NOT applied/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stays quiet inside a git repo, where fd applies .gitignore on its own", async () => {
		const dir = makeDir(true, true);
		try {
			expect(await ignoredRulesNotice(OLD_FD, dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stays quiet when there is no .gitignore whose rules could be skipped", async () => {
		const dir = makeDir(false, false);
		try {
			expect(await ignoredRulesNotice(OLD_FD, dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
