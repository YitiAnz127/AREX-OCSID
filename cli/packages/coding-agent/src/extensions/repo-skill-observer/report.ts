/**
 * Offline usage report built from the rotated event files.
 *
 * Used by `ocsid repo-skills usage` / `ocsid repo-skills report`. Reads the
 * JSONL events dir incrementally (stream-friendly per-file read), computes
 * statistics and merges the health snapshot.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { emptyHealth, readAllEvents, writeHealthFile, type ObserverHealth } from "./storage.ts";
import { computeUsageMetrics, type RepoUsageMetrics } from "./metrics.ts";

export interface UsageReport {
	metrics: RepoUsageMetrics;
	health: ObserverHealth;
	/** Scan-time malformed line count from the current files (not cumulative). */
	currentMalformed: number;
	eventCount: number;
	eventsDir: string;
}

export function buildUsageReport(eventsDir: string): UsageReport {
	const { events, malformed } = readAllEvents(eventsDir);
	const metrics = computeUsageMetrics(events);
	let health: ObserverHealth;
	try {
		const raw = readFileSync(join(eventsDir, "health.json"), "utf8");
		health = { ...emptyHealth(), ...(JSON.parse(raw) as Partial<ObserverHealth>) };
	} catch {
		health = emptyHealth();
	}
	// BUG-P1-04: `health.malformedLines` is a LIFETIME writer counter (persisted by
	// the writer). The scan-derived malformed count is a distinct, current value and
	// must NOT be folded into the cumulative counter, otherwise every report run
	// re-counts the same bad lines and the metric inflates monotonically.
	return { metrics, health, currentMalformed: malformed, eventCount: events.length, eventsDir };
}

/** Persist a fresh health snapshot from the given counters (CLI convenience). */
export function persistHealth(eventsDir: string, health: ObserverHealth): void {
	writeHealthFile(eventsDir, health);
}

/** True when the events dir exists and is non-empty. */
export function hasUsageData(eventsDir: string): boolean {
	return existsSync(eventsDir) && readAllEvents(eventsDir).events.length > 0;
}
