import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertCanonicalId, validateId, validateCaseId, resolveRunDir, isWithin, MAX_ID_LEN } from "./id.ts";

describe("canonical id validation", () => {
	it("accepts valid ids", () => {
		expect(validateId("abc-123.def_z", "runId")).toBeNull();
		expect(validateId("0", "runId")).toBeNull();
		expect(validateId("A", "skillId")).toBeNull();
		expect(validateId("x".repeat(128), "runId")).toBeNull();
	});

	it("rejects path traversal and absolute/drive/UNC ids", () => {
		expect(validateId("../evil", "runId")).not.toBeNull();
		expect(validateId("..", "runId")).not.toBeNull();
		expect(validateId("a/../../x", "runId")).not.toBeNull();
		expect(validateId("/etc/passwd", "runId")).not.toBeNull();
		expect(validateId("C:\\windows\\x", "runId")).not.toBeNull();
		expect(validateId("\\\\server\\share", "runId")).not.toBeNull();
		expect(validateId("a b", "runId")).not.toBeNull();
		expect(validateId("-leading-dash", "runId")).not.toBeNull(); // must start alnum
		expect(validateId("toolong".padEnd(MAX_ID_LEN + 1, "x"), "runId")).not.toBeNull();
		expect(validateId("", "runId")).not.toBeNull();
		expect(validateId(42, "runId")).not.toBeNull();
	});

	it("assertCanonicalId throws on invalid values", () => {
		expect(() => assertCanonicalId("../escape", "runId")).toThrow();
		expect(() => assertCanonicalId("ok-id", "runId")).not.toThrow();
	});
});

describe("benchmark case id validation", () => {
	it("accepts the relative case ids emitted by the benchmark loader", () => {
		expect(validateCaseId("sub-skills/cli-serving/multimolecule-command-preflight")).toBeNull();
		expect(validateCaseId("integration/python-api-train-then-predict")).toBeNull();
		expect(validateCaseId("root/simple-case")).toBeNull();
	});

	it.each(["/absolute", "a//b", "a/../b", "a/./b", "a\\b", "C:/windows", "../escape", "a b/c", "a/", ""])(
		"rejects unsafe case id %j",
		(caseId) => expect(validateCaseId(caseId)).not.toBeNull(),
	);
});

describe("path containment", () => {
	it("resolveRunDir stays inside the audit root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-id-"));
		try {
			const dir = resolveRunDir(root, "run-123");
			expect(path.dirname(dir)).toBe(path.join(path.resolve(root), "audit"));
			expect(isWithin(path.resolve(root, "audit"), dir)).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws on an id that would escape", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-id-"));
		try {
			expect(() => resolveRunDir(root, "../escape")).toThrow();
			expect(() => resolveRunDir(root, "C:\\evil")).toThrow();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("BUG (symlink escape): refuses a run dir that is a symlink pointing outside the audit root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-id-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-out-"));
		const audit = path.join(root, "audit");
		fs.mkdirSync(audit, { recursive: true });
		const link = path.join(audit, "run-sym");
		try {
			// Junction works for directories on Windows without admin/Dev-Mode.
			fs.symlinkSync(outside, link, "junction");
		} catch (err) {
			// No symlink permission in this environment: the logical path is at
			// least still resolved inside the root (no regression).
			expect(resolveRunDir(root, "run-sym")?.startsWith(audit)).toBe(true);
			return;
		}
		try {
			// resolveRunDir must refuse the escape-through-symlink.
			expect(() => resolveRunDir(root, "run-sym")).toThrow();
			// And nothing may have been written through the symlink to `outside`.
			expect(fs.readdirSync(outside)).toEqual([]);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
