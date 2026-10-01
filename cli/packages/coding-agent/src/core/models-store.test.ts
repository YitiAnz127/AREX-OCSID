import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileModelsStore } from "./models-store.ts";

describe("FileModelsStore corrupt-file resilience (F3)", () => {
	it("read() does not throw on a corrupt store file and returns undefined", async () => {
		const dir = mkdtempSync(join(tmpdir(), "models-store-"));
		const path = join(dir, "models-store.json");
		try {
			writeFileSync(path, "{ not valid json", "utf-8");
			const store = new FileModelsStore(path);
			await expect(store.read("openai")).resolves.toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("write() recovers a corrupt store file without throwing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "models-store-"));
		const path = join(dir, "models-store.json");
		try {
			writeFileSync(path, "{{{", "utf-8");
			const store = new FileModelsStore(path);
			await expect(store.write("openai", { models: [] } as any)).resolves.toBeUndefined();
			// After recovery the file is valid JSON containing the new entry.
			const store2 = new FileModelsStore(path);
			await expect(store2.read("openai")).resolves.toEqual({ models: [] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("delete() does not throw on a corrupt store file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "models-store-"));
		const path = join(dir, "models-store.json");
		try {
			writeFileSync(path, "] broken", "utf-8");
			const store = new FileModelsStore(path);
			await expect(store.delete("openai")).resolves.toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
