#!/usr/bin/env node
/**
 * Run a OCSID import/update command under the shared skill import lock.
 *
 * The lock serializes writes to OCSID's managed user skill library and its
 * live repo-skills-router across concurrent agent sessions. It intentionally
 * uses a directory lock so the helper works from the npm package without a
 * Python runtime or native fcntl bindings.
 *
 * Example:
 *   node with_import_lock.mjs -- node scripts/import_skill.mjs
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_SECONDS = 900;
const STALE_AFTER_SECONDS = 3600;
const POLL_SECONDS = 0.25;

function defaultAgentDir() {
	return process.env.OCSID_CODING_AGENT_DIR || path.join(os.homedir(), ".ocsid", "agent");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
	const args = {
		agentDir: defaultAgentDir(),
		timeout: DEFAULT_TIMEOUT_SECONDS,
		staleAfter: STALE_AFTER_SECONDS,
		command: [],
	};

	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--") {
			args.command = argv.slice(index + 1);
			return args;
		}
		if (value === "--agent-dir") {
			args.agentDir = argv[++index];
		} else if (value === "--timeout") {
			args.timeout = Number(argv[++index]);
		} else if (value === "--stale-after") {
			args.staleAfter = Number(argv[++index]);
		} else if (value === "-h" || value === "--help") {
			printHelp();
			process.exit(0);
		} else {
			args.command = argv.slice(index);
			return args;
		}
	}

	return args;
}

function printHelp() {
	console.log(`Usage: node with_import_lock.mjs [--agent-dir DIR] [--timeout SECONDS] [--stale-after SECONDS] -- COMMAND [ARGS...]

Run COMMAND while holding the OCSID skill import lock.`);
}

function lockOwnerPath(lockDir) {
	return path.join(lockDir, "owner.json");
}

function ownerPayload(token) {
	return {
		token,
		pid: process.pid,
		host: os.hostname(),
		started_at: new Date().toISOString(),
		argv: process.argv,
	};
}

function writeOwner(lockDir, token) {
	fs.writeFileSync(lockOwnerPath(lockDir), `${JSON.stringify(ownerPayload(token), null, 2)}\n`, "utf8");
}

function readOwnerToken(lockDir) {
	try {
		const owner = JSON.parse(fs.readFileSync(lockOwnerPath(lockDir), "utf8"));
		return typeof owner?.token === "string" ? owner.token : undefined;
	} catch {
		return undefined;
	}
}

function isStale(lockDir, staleAfterSeconds) {
	const now = Date.now();
	try {
		return now - fs.statSync(lockOwnerPath(lockDir)).mtimeMs > staleAfterSeconds * 1000;
	} catch (error) {
		if (!error || error.code !== "ENOENT") {
			return false;
		}
	}
	// The lock directory exists but `owner.json` does not: the holder was killed
	// between `mkdirSync(lockDir)` and `writeOwner`. Fall back to the lock
	// directory's own mtime, which the heartbeat refreshes, so such a lock stays
	// reclaimable. Treating it as never-stale instead would deadlock every later
	// run until the timeout, permanently, with no way to recover.
	try {
		return now - fs.statSync(lockDir).mtimeMs > staleAfterSeconds * 1000;
	} catch {
		return false;
	}
}

function startHeartbeat(lockDir, intervalSeconds) {
	const ownerFile = lockOwnerPath(lockDir);
	const timer = setInterval(() => {
		const now = new Date();
		try {
			fs.utimesSync(ownerFile, now, now);
			fs.utimesSync(lockDir, now, now);
		} catch {
			// A failed refresh (a transient EACCES/ENOENT, or a filesystem that
			// cannot update times) lets this lock age past `staleAfter`, at which
			// point another process may legitimately reclaim it while the command
			// below is still running. `release()` refuses to delete a lock this
			// process no longer owns, so the damage is bounded to two concurrent
			// importers rather than one clobbering the other's lock.
		}
	}, Math.max(1000, intervalSeconds * 1000));
	timer.unref();
	return () => clearInterval(timer);
}

async function acquireDirectoryLock(lockDir, timeoutSeconds, staleAfterSeconds) {
	const deadline = Date.now() + timeoutSeconds * 1000;

	for (;;) {
		try {
			fs.mkdirSync(path.dirname(lockDir), { recursive: true });
			fs.mkdirSync(lockDir);
			const token = randomUUID();
			let stopHeartbeat;
			try {
				writeOwner(lockDir, token);
				stopHeartbeat = startHeartbeat(lockDir, Math.min(Math.max(POLL_SECONDS, 1), staleAfterSeconds / 4));
			} catch (error) {
				// Never leave a half-created lock behind. Without this, a failure
				// between mkdir and writeOwner strands a lock directory that every
				// later run has to wait out.
				fs.rmSync(lockDir, { recursive: true, force: true });
				throw error;
			}
			return {
				lockPath: lockDir,
				release() {
					stopHeartbeat();
					// Only remove a lock this process still owns. If the heartbeat
					// stalled long enough for another process to reclaim the lock,
					// deleting the directory here would destroy a live lock and let
					// two imports run concurrently — the exact thing the lock exists
					// to prevent.
					if (readOwnerToken(lockDir) !== token) {
						return;
					}
					fs.rmSync(lockDir, { recursive: true, force: true });
				},
			};
		} catch (error) {
			if (!error || error.code !== "EEXIST") {
				throw error;
			}
			if (isStale(lockDir, staleAfterSeconds)) {
				// Reclaim atomically. Testing staleness and then removing the
				// directory is a TOCTOU: between the check and the removal another
				// process can reclaim the stale lock and create a fresh one, which
				// this process then deletes — letting two holders run at once. A
				// `rename` to a unique name can only succeed for one waiter.
				const graveyard = `${lockDir}.stale.${process.pid}.${Date.now()}`;
				let reclaimed = false;
				try {
					fs.renameSync(lockDir, graveyard);
					reclaimed = true;
				} catch {
					// Another waiter reclaimed it first; retry from the top.
				}
				if (reclaimed) {
					// Re-verify what was actually taken. A live holder can create a
					// fresh lock between the staleness test above and this rename, in
					// which case the directory moved aside is that live lock: put it
					// back rather than delete it.
					if (isStale(graveyard, staleAfterSeconds)) {
						fs.rmSync(graveyard, { recursive: true, force: true });
					} else {
						try {
							fs.renameSync(graveyard, lockDir);
						} catch {
							// The lock was taken while it was held aside, so what was
							// moved is a stale leftover; drop it.
							fs.rmSync(graveyard, { recursive: true, force: true });
						}
					}
				}
				// Bound this path. A persistent rename failure (a read-only parent, a
				// handle open inside the directory) would otherwise spin here at full
				// CPU with no deadline check and no backoff, because `isStale` keeps
				// reporting true.
				if (Date.now() >= deadline) {
					throw new Error(`timed out waiting for import lock at ${lockDir}`);
				}
				await sleep(POLL_SECONDS * 1000);
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`timed out waiting for import lock at ${lockDir}`);
			}
			await sleep(POLL_SECONDS * 1000);
		}
	}
}

function runCommand(command, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command[0], command.slice(1), {
			env,
			stdio: "inherit",
			shell: false,
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (signal) {
				resolve(128);
			} else {
				resolve(code ?? 0);
			}
		});
	});
}

async function main(argv) {
	const args = parseArgs(argv);
	if (!args.command.length) {
		console.error("with_import_lock.mjs: provide a command after '--'");
		return 2;
	}
	if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
		console.error("with_import_lock.mjs: --timeout must be a positive number");
		return 2;
	}
	if (!Number.isFinite(args.staleAfter) || args.staleAfter <= 0) {
		console.error("with_import_lock.mjs: --stale-after must be a positive number");
		return 2;
	}

	const agentDir = path.resolve(args.agentDir.replace(/^~(?=$|[\\/])/, os.homedir()));
	const lockDir = path.join(agentDir, "locks", "repo-skills-import.lockdir");

	let lock;
	try {
		lock = await acquireDirectoryLock(lockDir, args.timeout, args.staleAfter);
		const env = {
			...process.env,
			OCSID_IMPORT_LOCK_PATH: lock.lockPath,
			OCSID_CODING_AGENT_DIR: agentDir,
		};
		return await runCommand(args.command, env);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return /timed out waiting/.test(String(error)) ? 75 : 1;
	} finally {
		if (lock) {
			lock.release();
		}
	}
}

process.exitCode = await main(process.argv.slice(2));
