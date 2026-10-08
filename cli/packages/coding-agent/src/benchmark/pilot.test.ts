import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectPilotSkills, type SkillProfile } from "./pilot";
import { assignDeterministicSplits, buildManifest } from "./schema";
import { computeBenchmarkContentDigest, computeBenchmarkSplitDigests } from "../audit/loader.ts";
import { OFFICIAL_BENCHMARK_DIR, OFFICIAL_BENCHMARK_NAME } from "./freeze.ts";

const FIXTURE = join(__dirname, "..", "..", "test", "fixtures", "benchmark", "skill-profiles.json");

function loadProfiles(): SkillProfile[] {
	const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as { profiles: SkillProfile[] };
	return raw.profiles;
}

describe("pilot benchmark selection", () => {
	it("loads the committed skill profiles fixture", () => {
		const profiles = loadProfiles();
		expect(profiles.length).toBeGreaterThanOrEqual(100);
		expect(new Set(profiles.map((p) => p.skillId)).size).toBe(profiles.length);
	});

	it("selects 8..12 unique pilot skills deterministically", () => {
		const profiles = loadProfiles();
		const once = selectPilotSkills(profiles, { target: 10 });
		const twice = selectPilotSkills(profiles, { target: 10 });
		expect(once).toEqual(twice);
		expect(once.length).toBeGreaterThanOrEqual(8);
		expect(once.length).toBeLessThanOrEqual(12);
		expect(new Set(once).size).toBe(once.length); // no duplicates
	});

	it("keeps every present category represented in the pilot", () => {
		const profiles = loadProfiles();
		const present = new Set(profiles.map((p) => p.category));
		const selected = new Set(selectPilotSkills(profiles, { target: 10 }));
		const selectedCats = new Set(profiles.filter((p) => selected.has(p.skillId)).map((p) => p.category));
		for (const category of present) {
			expect(selectedCats.has(category)).toBe(true);
		}
	});

	it("builds a deterministic frozen manifest with a stable splitHash", () => {
		const profiles = loadProfiles();
		const pilot = selectPilotSkills(profiles, { target: 10 });
		const splits = assignDeterministicSplits(pilot);
		const manifest = buildManifest("pilot-v1", "2026-01-01T00:00:00Z", splits);

		// Rebuilding must reproduce the exact same manifest.
		const manifest2 = buildManifest("pilot-v1", "2026-01-01T00:00:00Z", assignDeterministicSplits(pilot));
		expect(manifest).toEqual(manifest2);

		// Every pilot skill appears exactly once across the three splits.
		const all = [...manifest.splits.train, ...manifest.splits.dev, ...manifest.splits.heldout];
		expect(new Set(all).size).toBe(all.length);
		expect(all.length).toBe(pilot.length);

		// splitHash is a 64-hex sha256 over the canonical split encoding.
		expect(manifest.splitHash).toMatch(/^[0-9a-f]{64}$/);

		// Deterministic split sizes given the pilot length.
		expect(manifest.splits.heldout.length).toBe(3);
		expect(manifest.splits.dev.length).toBe(3);
		expect(manifest.splits.train.length).toBe(pilot.length - 6);

		// Print the frozen manifest so its exact content can be captured verbatim
		// and committed as the authoritative benchmark artifact.
		const text = JSON.stringify(manifest, null, 2);
		console.log("PILOT_MANIFEST=" + text);
		if (process.env.BENCH_TEST_OUT) {
			writeFileSync(process.env.BENCH_TEST_OUT, text + "\n", "utf8");
		}
	});

	it("committed pilot manifest reproduces the identical splitHash", () => {
		const committedPath = join(
			__dirname,
			"..",
			"..",
			"..",
			"..",
			"..",
			"skills",
			"tests",
			OFFICIAL_BENCHMARK_DIR,
			"manifest.json",
		);
		const committed = JSON.parse(readFileSync(committedPath, "utf8")) as {
			frozenAt: string;
			splitHash: string;
			splits: Record<string, string[]>;
			contentHash: string;
			contentHashes: Record<string, string>;
		};
		const splitList = Object.entries(committed.splits).flatMap(([split, ids]) =>
			ids.map((skillId) => ({ skillId, split })),
		);
		const rebuilt = buildManifest(OFFICIAL_BENCHMARK_NAME, committed.frozenAt, splitList);
		expect(rebuilt.splitHash).toBe(committed.splitHash);
		const skillRoot = join(committedPath, "..", "..");
		expect(committed.contentHashes).toEqual(computeBenchmarkSplitDigests(skillRoot, rebuilt.splits));
		expect(committed.contentHash).toBe(computeBenchmarkContentDigest(skillRoot, rebuilt.splits));
		expect({ ...rebuilt, contentHashes: committed.contentHashes, contentHash: committed.contentHash }).toEqual(committed);
	});
});
