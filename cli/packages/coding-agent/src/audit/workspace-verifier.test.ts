import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkspaceVerifier, verifyWorkspace } from "./workspace-verifier.ts";

describe("private workspace verifier", () => {
	it("checks real output files and numeric JSON values", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocsid-verifier-"));
		try {
			fs.mkdirSync(path.join(root, "output"));
			const specFile = path.join(root, "hidden.json");
			fs.writeFileSync(specFile, JSON.stringify({ schema: "ocsid.workspace-verifier.v1", checks: [
				{ type: "file-exists", path: "output/result.json" },
				{ type: "json-number-range", path: "output/result.json", key: "count", min: 2, max: 4 },
			] }));
			const verifier = loadWorkspaceVerifier(specFile);
			expect(verifyWorkspace(root, verifier).perAssertion.map((x) => x.score)).toEqual([0, 0]);
			fs.writeFileSync(path.join(root, "output", "result.json"), '{"count":3}');
			expect(verifyWorkspace(root, verifier).perAssertion.map((x) => x.score)).toEqual([1, 1]);
			fs.writeFileSync(path.join(root, "output", "result.json"), '{"count":99}');
			expect(verifyWorkspace(root, verifier).perAssertion.map((x) => x.score)).toEqual([1, 0]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects verifier paths outside output", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocsid-verifier-"));
		try {
			const specFile = path.join(root, "hidden.json");
			fs.writeFileSync(specFile, JSON.stringify({ schema: "ocsid.workspace-verifier.v1", checks: [
				{ type: "file-exists", path: "output/../secret" },
			] }));
			expect(() => loadWorkspaceVerifier(specFile)).toThrow(/safe relative paths/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
