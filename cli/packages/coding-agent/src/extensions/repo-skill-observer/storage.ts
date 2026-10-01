/**
 * Rotation JSONL storage for RepoSkill events.
 *
 * Design (per the RSI plan):
 * - Write into a local agent dir (`~/.disco/agent/rsi/events/`), never into the
 *   managed skill tree.
 * - In-memory queue + batch append; write failures MUST NOT block or crash the
 *   host agent — they only increment a health counter (`dropped_events`).
 * - Rotate files by size; a separate `health.json` exposes counters so CLI
 *   `repo-skills report` can surface lost/malformed rows.
 * - CLI summarizers stream the files instead of loading all history.
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { RepoSkillEvent } from "./events.ts";

const DEFAULT_ROTATE_BYTES = 4 * 1024 * 1024; // 4 MiB per file

export interface ObserverHealth {
	/** Total events accepted (enqueued) since process start. */
	totalEvents: number;
	/** Events dropped because flush failed (write errors). */
	droppedEvents: number;
	/** Malformed lines read back from the active file during summary. */
	malformedLines: number;
	/** Last successful write timestamp (ms epoch) or null. */
	lastWriteMs: number | null;
	/** First enqueue timestamp (ms epoch) or null. */
	startedMs: number | null;
}

/**
 * A small helper producing a UUID v4 event id via node:crypto.
 */
export function makeEventId(seed?: string): string {
	return seed ?? randomUUID();
}

export function emptyHealth(): ObserverHealth {
	return {
		totalEvents: 0,
		droppedEvents: 0,
		malformedLines: 0,
		lastWriteMs: null,
		startedMs: null,
	};
}

export class ObserverWriter {
	private readonly dir: string;
	private readonly rotateBytes: number;
	private queue: RepoSkillEvent[] = [];
	private activeFile: string;
	private flushTimer: NodeJS.Timeout | null = null;
	private closed = false;
	private readonly health: ObserverHealth = emptyHealth();
	// BUG-P1-07: each writer owns a unique (pid + uuid + monotonic seq) namespace
	// for its file names so concurrent processes / same-millisecond rotations can
	// NEVER collide on the same JSONL file and corrupt it.
	private readonly runId = `${process.pid}-${makeEventId()}`;
	private seq = 0;

	constructor(options: { dir: string; rotateBytes?: number; flushIntervalMs?: number }) {
		this.dir = options.dir;
		this.rotateBytes = options.rotateBytes ?? DEFAULT_ROTATE_BYTES;
		mkdirSync(this.dir, { recursive: true });
		this.activeFile = this.nextFileName();
		this.health.startedMs ??= Date.now();

		const flushMs = options.flushIntervalMs ?? 2_000;
		if (flushMs > 0) {
			this.flushTimer = setInterval(() => {
				void this.flush();
			}, flushMs);
			// Do not keep the process alive just because of the flusher.
			this.flushTimer.unref?.();
		}
	}

	/** Enqueue a row. Never throws: on write error it records the drop. */
	enqueue(event: RepoSkillEvent): void {
		if (this.closed) return;
		this.health.totalEvents += 1;
		this.queue.push(event);
		// Rotate lazily on flush; also force when the active file is large.
		if (this.queue.length >= 512) {
			void this.flush();
		}
	}

	/** Synchronously flush queued rows to the active JSONL file. */
	flush(): void {
		if (this.closed || this.queue.length === 0) return;
		const batch = this.queue;
		this.queue = [];
		try {
			this.rotateIfNeeded();
			let out = "";
			for (const e of batch) out += JSON.stringify(e) + "\n";
			appendFileSync(this.activeFile, out, "utf8");
			this.health.lastWriteMs = Date.now();
			// BUG-P1-03: persist the lifetime health snapshot on every successful
			// write so a later process/CLI sees fresh counters instead of a stale file.
			this.persistHealth();
		} catch {
			this.health.droppedEvents += batch.length;
			// Re-enqueue is intentionally NOT attempted: we must not grow memory
			// indefinitely or risk infinite retry loops under a failing disk.
		}
	}

	/** Health counters, copied so callers get a stable snapshot. */
	snapshotHealth(): ObserverHealth {
		return { ...this.health };
	}

	/** Absolute path of the active file (useful for tests/debug). */
	activeFilePath(): string {
		return this.activeFile;
	}

	/** Stop the periodic flusher and flush+persist. Idempotent (BUG-P1-02). */
	close(): void {
		if (this.closed) return;
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		// Flush the queued rows first (while still "open" so flush() writes them),
		// then mark closed to block any subsequent enqueue/flush.
		this.flush();
		this.closed = true;
		this.persistHealth();
	}

	/** Atomically persist the in-memory lifetime health snapshot (BUG-P1-03). */
	persistHealth(): void {
		writeHealthFile(this.dir, this.health);
	}

	private rotateIfNeeded(): void {
		try {
			const st = statSync(this.activeFile);
			if (st.size >= this.rotateBytes) {
				this.activeFile = this.nextFileName();
			}
		} catch {
			// File absent yet — nothing to rotate.
		}
	}

	private nextFileName(): string {
		// Unique per (process, writer, rotation): `seq` is monotonic so a fresh
		// name is guaranteed even when Date.now() is identical across rotations.
		return join(this.dir, `events-${this.runId}-${this.seq++}.jsonl`);
	}
}

/**
 * Read all event rows across the events dir.
 *
 * BUG-P1-08: files are read in BOUNDED CHUNKS via openSync/readSync and split
 * into lines incrementally, instead of slurping the whole file with
 * readFileSync + split("\n"). A large rotated history never lands in RAM as one
 * giant string — memory stays bounded to a chunk buffer plus one line at a
 * time. An optional `onEvent` callback lets a caller consume rows as they are
 * parsed without materializing the full array.
 */
export function readAllEvents(
	dir: string,
	onEvent?: (event: RepoSkillEvent) => void,
): { events: RepoSkillEvent[]; malformed: number } {
	const events: RepoSkillEvent[] = [];
	let malformed = 0;
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
	// The judgement authoring ledger is a normal event stream (judgements.jsonl
	// carries schema'd task_judgement rows). Its sibling judgements.provenance.jsonl
	// is a BEST-EFFORT authoring record with a different, non-event schema (no
	// eventType) — it must never be read as an event stream, or every line would
	// be counted as malformed (BUG-P1-09/P1-04 hygiene).
	names = names.filter((n) => n !== "judgements.provenance.jsonl");
	} catch {
		return { events, malformed };
	}
	names.sort();
	for (const n of names) {
		const p = join(dir, n);
		awaitLines(p, (line) => {
			const t = line.trimEnd();
			if (!t) return;
			try {
				const parsed = JSON.parse(t) as RepoSkillEvent;
				if (parsed && parsed.eventType) {
					events.push(parsed);
					onEvent?.(parsed);
				} else malformed += 1;
			} catch {
				malformed += 1;
			}
		});
	}
	return { events, malformed };
}

/**
 * Read a file in bounded chunks and emit each complete line.
 * Never slurps the file into one string; memory stays flat.
 */
function awaitLines(file: string, onLine: (line: string) => void): void {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return;
	}
	try {
		const buf = Buffer.alloc(64 * 1024);
		let carry = "";
		let bytesRead = 0;
		do {
			bytesRead = readSync(fd, buf, 0, buf.length, null);
			if (bytesRead <= 0) break;
			carry += buf.toString("utf8", 0, bytesRead);
			let nl: number;
			while ((nl = carry.indexOf("\n")) !== -1) {
				onLine(carry.slice(0, nl));
				carry = carry.slice(nl + 1);
			}
		} while (bytesRead > 0);
		if (carry.length > 0) onLine(carry); // trailing line without a newline
	} finally {
		closeSync(fd);
	}
}

/** Persist a health snapshot to `health.json` in the events dir. */
export function writeHealthFile(dir: string, health: ObserverHealth): void {
	try {
		mkdirSync(dir, { recursive: true });
		const target = join(dir, "health.json");
		// Atomic tmp+rename. A torn write is not merely cosmetic here: report.ts
		// falls back to emptyHealth() when the file will not parse, which silently
		// ZEROES the lifetime droppedEvents/totalEvents counters — the very evidence
		// that events were lost — so corruption reads as a perfectly healthy run.
		const tmpPath = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
		writeFileSync(tmpPath, JSON.stringify(health, null, 2), "utf8");
		renameSync(tmpPath, target);
	} catch {
		// Health file is best-effort; never throw.
	}
}
