import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuthStorageBackend } from "./auth-storage.ts";

function makeBackend(): { dir: string; path: string; backend: FileAuthStorageBackend } {
	const dir = mkdtempSync(join(tmpdir(), "auth-storage-"));
	return { dir, path: join(dir, "auth.json"), backend: new FileAuthStorageBackend(join(dir, "auth.json")) };
}

describe("FileAuthStorageBackend atomic writes (F2)", () => {
	it("sync write lands content and leaves no .tmp orphan", () => {
		const { dir, path, backend } = makeBackend();
		try {
			backend.withLock((current) => ({ result: undefined, next: JSON.stringify({ a: 1 }) }));
			expect(existsSync(path)).toBe(true);
			expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ a: 1 });
			// Temp sibling must be renamed away (atomic temp+rename, not truncate+t-write).
			expect(existsSync(`${path}.tmp`)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("async write lands content and leaves no .tmp orphan", async () => {
		const { dir, path, backend } = makeBackend();
		try {
			await backend.withLockAsync(async (current) => ({
				result: undefined,
				next: JSON.stringify({ b: "secret", nested: { providerId: "openai" } }),
			}));
			expect(existsSync(path)).toBe(true);
			expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ b: "secret", nested: { providerId: "openai" } });
			expect(existsSync(`${path}.tmp`)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates an empty {} store file on first touch", () => {
		const { dir, path, backend } = makeBackend();
		try {
			backend.withLock((current) => ({ result: current }));
			expect(existsSync(path)).toBe(true);
			expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
