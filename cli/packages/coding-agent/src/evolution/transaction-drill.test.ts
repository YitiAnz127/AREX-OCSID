import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRollbackDrill, createDrillAdapter } from "./transaction-drill.ts";
import { createPromotionTransaction } from "./transact.ts";
import { makeProposal } from "./propose-only.ts";
import type { EvolveProposal } from "./types.ts";

function scratch(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "arex-drill-"));
	return dir;
}

function proposal(): EvolveProposal {
	return makeProposal({ roundId: "r3", targetSkillId: "chemprop", hypothesis: "h", plan: ["p"], evidence: { source: "s", finding: "f", empirical: false }, generatedAt: "T" });
}

describe("Step 5 rollback drill (staging-only, never touches live skills)", () => {
	it("restores original content and leaves no candidate behind", () => {
		const sandbox = scratch();
		try {
			const res = runRollbackDrill(sandbox, { "candidate.json": "C" });
			expect(res.restored).toBe(true);
			expect(res.notes).toContain("rollback: backup restored to live");
			// original files back
			const skill = JSON.parse(readFileSync(path.join(sandbox, "live", "skill.json"), "utf8"));
			expect(skill.version).toBe("v1");
			expect(res.restoredContent).not.toHaveProperty("candidate.json");
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it("disabled drill adapter refuses (human-gated symmetry)", () => {
		const adapter = createDrillAdapter({ sandbox: scratch(), enable: false });
		const r = adapter.applyPatch(proposal());
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("human-gated");
	});

	it("enabled drill adapter completes and restores via the transaction contract", () => {
		const sandbox = scratch();
		try {
			const adapter = createDrillAdapter({ sandbox, enable: true });
			const tx = createPromotionTransaction({ humanApprovalRef: "TKT-7", adapter });
			expect(tx.acquire("chemprop")).toBe(true);
			tx.stage(proposal());
			const r = tx.apply();
			expect(r.ok).toBe(true);
			// live skill.json still original (drill restored it)
			const skill = JSON.parse(readFileSync(path.join(sandbox, "live", "skill.json"), "utf8"));
			expect(skill.version).toBe("v1");
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
