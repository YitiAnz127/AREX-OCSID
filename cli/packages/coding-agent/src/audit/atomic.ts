/**
 * Atomic file writes.
 *
 * A write is torn only if a reader sees the file mid-write, or a writer leaves
 * a partial file when killed. Writing to a `.tmp` sibling and then `rename`-ing
 * over the target makes the final path either the old or the new content,
 * never a mix.
 *
 * BUG-P1-xx (finding 3): the tmp name must be UNIQUE per write. A fixed
 * `<target>.tmp` (as two concurrent writers on the same runId would use) lets
 * one process clobber the other's tmp before its rename, corrupting the file.
 * We therefore derive the tmp suffix from the process pid plus a per-call
 * counter, so concurrent/independent writers never collide on the same tmp.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import * as path from "node:path";

let tmpSeq = 0;

/** Generate a unique sibling tmp path for `target` (pid + counter + uuid). */
export function uniqueTmpPath(target: string): string {
	const base = path.basename(target);
	const suffix = `${process.pid}-${tmpSeq++}-${randomUUID().slice(0, 8)}`;
	return path.join(path.dirname(target), `${base}.tmp-${suffix}`);
}

/**
 * fsync a directory so a rename that happened inside it survives a power loss.
 * POSIX only: opening a directory fails on Windows, which is caught and
 * ignored — the rename itself is still atomic there.
 */
function fsyncDirectorySync(dir: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(dir, "r");
		fsyncSync(fd);
	} catch {
		// Best-effort durability refinement; not supported on every platform.
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closed
			}
		}
	}
}

/**
 * Write `data` to `target` atomically via a unique tmp file + rename.
 * The tmp lives in the same directory as `target` so the rename stays on one
 * filesystem and is atomic. On failure the orphaned tmp is best-effort
 * removed, then the original error propagates.
 *
 * The tmp is fsync'd before the rename, and the parent directory after it.
 * Without the first flush the rename can be persisted while the tmp's contents
 * are still in the page cache, so a crash leaves a zero-length or truncated
 * file at `target` — the torn write this module exists to prevent. Without the
 * second, the rename itself may not be durable.
 */
export function atomicWriteFileSync(target: string, data: string | Buffer, encoding?: BufferEncoding): void {
	const tmp = uniqueTmpPath(target);
	const payload = typeof data === "string" ? Buffer.from(data, encoding) : data;
	let fd: number | undefined;
	try {
		fd = openSync(tmp, "w");
		// writeSync may write fewer bytes than requested, so loop until drained.
		let offset = 0;
		while (offset < payload.length) {
			offset += writeSync(fd, payload, offset, payload.length - offset);
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tmp, target);
		fsyncDirectorySync(path.dirname(target));
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closed
			}
		}
		// Clean up unconditionally: a write that fails partway (ENOSPC/EIO/killed)
		// has already created the tmp, so gating cleanup on a post-write flag left
		// exactly those partial files behind. rmSync with force is a no-op when the
		// rename already moved the tmp away.
		try {
			rmSync(tmp, { force: true });
		} catch {
			// best-effort cleanup only
		}
		throw error;
	}
}
