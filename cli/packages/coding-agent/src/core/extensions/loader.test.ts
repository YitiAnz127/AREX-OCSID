import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverExtensionsInDir } from "./loader.ts";

describe("discoverExtensionsInDir symlink policy", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
		roots.length = 0;
	});

	function makeExtensionsDir(): { extensions: string; outside: string } {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "disco-ext-loader-"));
		roots.push(root);
		const extensions = path.join(root, "extensions");
		const outside = path.join(root, "outside");
		fs.mkdirSync(extensions, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		return { extensions, outside };
	}

	function trySymlink(target: string, link: string, type?: "file" | "dir"): boolean {
		try {
			fs.symlinkSync(target, link, type as fs.symlink.Type);
			return true;
		} catch {
			// Windows without admin/Dev-Mode (or an unsupported type): we cannot
			// create the symlink, so fall back to asserting no regression.
			return false;
		}
	}

	it("discovers real extension files and real subdirectory index entries", () => {
		const { extensions } = makeExtensionsDir();
		fs.writeFileSync(path.join(extensions, "alpha.ts"), "export default {};\n");
		fs.mkdirSync(path.join(extensions, "beta"), { recursive: true });
		fs.writeFileSync(path.join(extensions, "beta", "index.ts"), "export default {};\n");
		fs.writeFileSync(path.join(extensions, "notes.txt"), "not an extension\n");

		const discovered = discoverExtensionsInDir(extensions).sort();
		expect(discovered).toEqual([
			path.join(extensions, "alpha.ts"),
			path.join(extensions, "beta", "index.ts"),
		]);
	});

	it("BUG (symlink escape): never loads a symlink file pointing outside the extensions dir", () => {
		const { extensions, outside } = makeExtensionsDir();
		const victim = path.join(outside, "evil.ts");
		fs.writeFileSync(victim, "globalThis.PWNED = true; export default {};\n");
		const link = path.join(extensions, "evil.ts");

		if (!trySymlink(victim, link, "file")) {
			// Cannot create the symlink here; assert no regression (nothing discovered).
			expect(discoverExtensionsInDir(extensions)).toEqual([]);
			return;
		}

		const discovered = discoverExtensionsInDir(extensions);
		expect(discovered).not.toContain(link);
	});

	it("BUG (symlink escape): never descends into a symlinked directory pointing outside", () => {
		const { extensions, outside } = makeExtensionsDir();
		fs.mkdirSync(path.join(outside, "pkg"), { recursive: true });
		fs.writeFileSync(path.join(outside, "pkg", "index.ts"), "export default {};\n");
		const link = path.join(extensions, "pkg");

		if (!trySymlink(path.join(outside, "pkg"), link, "dir")) {
			// Cannot create the directory symlink; assert no regression.
			expect(discoverExtensionsInDir(extensions)).toEqual([]);
			return;
		}

		const discovered = discoverExtensionsInDir(extensions);
		expect(discovered).not.toContain(path.join(link, "index.ts"));
	});

	it("returns [] for a missing extensions directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "disco-ext-loader-"));
		roots.push(root);
		expect(discoverExtensionsInDir(path.join(root, "does-not-exist"))).toEqual([]);
	});
});
