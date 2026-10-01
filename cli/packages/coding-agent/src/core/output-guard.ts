interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

const GRACEFUL_EXIT_GRACE_MS = 250;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

/**
 * Exit with `code` after a short grace so pending libuv handles — most notably
 * an in-flight fetch() — can finish closing. On Windows an immediate
 * process.exit() while an async/fetch handle is still closing asserts
 * `UV_HANDLE_CLOSING` (src/win/async.c:76, https://github.com/nodejs/node/issues/56645)
 * and prints as a spurious crash after the real work already completed.
 *
 * We set process.exitCode and arm an unref'd timer: if the event loop drains
 * naturally first, the process exits with `code`; if a handle is wedged and
 * keeps the loop alive, the timer fires and force-exits as a hard fallback.
 * For a graceful shutdown the caller should first flush pending stdout/stderr
 * (see safeExit in main.ts) so no write is left in a libuv pipe when we exit.
 */
export function armGracefulExit(code?: number | string | undefined): void {
	process.exitCode = code;
	const timer = setTimeout(() => process.exit(code), GRACEFUL_EXIT_GRACE_MS);
	timer.unref();
}

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		// P2-02 (P2-2): any non-backpressure write failure — most notably EPIPE
		// when stdout is piped to a closed consumer (`... | head -1`) — must exit
		// the process (the raw stdout channel is gone, so nothing can be rendered),
		// but a bare process.exit(1) here can race a pending fetch and trip libuv's
		// UV_HANDLE_CLOSING assert on Windows. Defer by ~250ms so pending handles
		// close first; a wedged handle makes the grace timer fire as the fallback.
		armGracefulExit(1);
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
