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
import { renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

let tmpSeq = 0;

/** Generate a unique sibling tmp path for `target` (pid + counter + uuid). */
export function uniqueTmpPath(target: string): string {
	const base = path.basename(target);
	const suffix = `${process.pid}-${tmpSeq++}-${randomUUID().slice(0, 8)}`;
	return path.join(path.dirname(target), `${base}.tmp-${suffix}`);
}

/**
 * Write `data` to `target` atomically via a unique tmp file + rename.
 * The tmp lives in the same directory as `target` so the rename stays on one
 * filesystem and is atomic. On failure the orphaned tmp is best-effort
 * removed, then the original error propagates.
 */
export function atomicWriteFileSync(target: string, data: string | Buffer, encoding?: BufferEncoding): void {
	const tmp = uniqueTmpPath(target);
	try {
		writeFileSync(tmp, data, encoding);
		renameSync(tmp, target);
	} catch (error) {
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
