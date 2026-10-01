import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertExtractedTreeContained } from "../src/utils/tools-manager.ts";

/**
 * The fd/ripgrep binaries are downloaded and executed. Extraction shells out to
 * whichever of tar/unzip/Expand-Archive is on PATH, so containment is a property
 * of the host's extractor rather than of this program — this check is the
 * backstop before a located binary is renamed into place and made executable.
 */
describe("assertExtractedTreeContained", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "disco-extract-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("accepts a normal nested release tree", () => {
		const nested = join(root, "fd-v10.0.0-x86_64-pc-windows-msvc");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "fd.exe"), "binary");
		writeFileSync(join(root, "README.md"), "readme");

		expect(() => assertExtractedTreeContained(root)).not.toThrow();
	});

	it("rejects a symlink member", () => {
		// A planted `fd -> /usr/bin/whatever` would otherwise be renamed into the
		// tools dir and executed as the grep/find backend.
		writeFileSync(join(root, "real.txt"), "x");
		try {
			symlinkSync(join(root, "real.txt"), join(root, "link.txt"), "file");
		} catch {
			return; // symlink creation needs privileges on Windows; skip there
		}

		expect(() => assertExtractedTreeContained(root)).toThrow(/symlink/i);
	});

	it("rejects a directory symlink pointing outside the tree", () => {
		const outside = mkdtempSync(join(tmpdir(), "disco-outside-"));
		try {
			writeFileSync(join(outside, "fd.exe"), "attacker");
			try {
				symlinkSync(outside, join(root, "nested"), "junction");
			} catch {
				return; // needs privileges on Windows
			}

			expect(() => assertExtractedTreeContained(root)).toThrow(/symlink|escapes/i);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
