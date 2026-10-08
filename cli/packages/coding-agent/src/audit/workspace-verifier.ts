/** Independent checks over files produced in a case workspace. The model never receives this spec. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { GradeSpec } from "./types.ts";

export type Check =
	| { type: "file-exists"; path: string }
	| { type: "json-number-range"; path: string; key: string; min?: number; max?: number };

export interface WorkspaceVerifier {
	readonly sha256: string;
	readonly checks: readonly Check[];
	/**
	 * P1-02: the exact text `sha256` was computed over, so an archived run can
	 * bind and later replay the verifier without the operator's private file.
	 */
	readonly text: string;
}

/** Load and validate the private verifier before starting an agent run. */
export function loadWorkspaceVerifier(file: string): WorkspaceVerifier {
	return parseWorkspaceVerifier(fs.readFileSync(file).toString("utf8"));
}

/**
 * P1-02: validate a verifier from its literal text. `loadWorkspaceVerifier` reads
 * a private file that is deliberately kept out of the agent's tree, so an
 * archived run must bind the verifier *bytes* (not a path) to be replayable
 * after the operator's file is gone. Shares one validator with the file path so
 * an archived verifier can never be more permissive than a live one. The
 * `sha256` is over the exact text given (UTF-8), matching the file-path digest.
 */
export function parseWorkspaceVerifier(text: string): WorkspaceVerifier {
	const raw = Buffer.from(text, "utf8");
	const parsed: unknown = JSON.parse(raw.toString("utf8"));
	if (!parsed || typeof parsed !== "object") throw new Error("verifier must be a JSON object");
	const spec = parsed as { schema?: unknown; checks?: unknown };
	if (spec.schema !== "ocsid.workspace-verifier.v1" || !Array.isArray(spec.checks) || spec.checks.length === 0) {
		throw new Error("verifier requires schema ocsid.workspace-verifier.v1 and nonempty checks");
	}
	if (spec.checks.length > 100) throw new Error("verifier has too many checks");
	const checks: Check[] = spec.checks.map((value: unknown) => {
		if (!value || typeof value !== "object") throw new Error("verifier check must be an object");
		const c = value as Record<string, unknown>;
		if (typeof c.path !== "string" || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(c.path) ||
			c.path.split("/").includes("..") || !c.path.startsWith("output/")) {
			throw new Error("verifier paths must be safe relative paths below output/");
		}
		if (c.type === "file-exists") return { type: "file-exists", path: c.path };
		if (c.type === "json-number-range" && typeof c.key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.key) &&
			(c.min === undefined || (typeof c.min === "number" && Number.isFinite(c.min))) &&
			(c.max === undefined || (typeof c.max === "number" && Number.isFinite(c.max))) &&
			(c.min !== undefined || c.max !== undefined) &&
			(c.min === undefined || c.max === undefined || c.min <= c.max)) {
			return { type: "json-number-range", path: c.path, key: c.key,
				...(c.min === undefined ? {} : { min: c.min as number }),
				...(c.max === undefined ? {} : { max: c.max as number }) };
		}
		throw new Error(`unsupported or invalid verifier check: ${String(c.type)}`);
	});
	return { sha256: createHash("sha256").update(raw).digest("hex"), checks, text: raw.toString("utf8") };
}

/** Check only actual regular files in output/. Missing or malformed outputs fail their checks. */
export function verifyWorkspace(workspaceRoot: string, verifier: WorkspaceVerifier): GradeSpec {
	const outputRoot = path.resolve(workspaceRoot, "output");
	return {
		perAssertion: verifier.checks.map((check) => {
			const target = path.resolve(workspaceRoot, ...check.path.split("/"));
			let passed = false;
			try {
				const real = fs.realpathSync(target);
				const stat = fs.statSync(real);
				if ((real === outputRoot || real.startsWith(outputRoot + path.sep)) && stat.isFile()) {
					if (check.type === "file-exists") passed = true;
					else if (stat.size <= 1024 * 1024) {
						const doc: unknown = JSON.parse(fs.readFileSync(real, "utf8"));
						const value = doc && typeof doc === "object" ? (doc as Record<string, unknown>)[check.key] : undefined;
						passed = typeof value === "number" && Number.isFinite(value) &&
							(check.min === undefined || value >= check.min) && (check.max === undefined || value <= check.max);
					}
				}
			} catch { /* missing, unreadable, or malformed output is a failed check */ }
			return { assertion: JSON.stringify(check), outcome: passed ? "pass" as const : "fail" as const, score: passed ? 1 : 0 };
		}),
	};
}
