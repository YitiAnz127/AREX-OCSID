import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	animateOCSIDSplash,
	OCSIDSplash,
	formatStartupTagline,
	shouldShowOCSIDStartupSplash,
} from "../src/modes/interactive/components/ocsid-splash.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("OCSID startup splash", () => {
	it("only enables the splash for an interactive TTY", () => {
		const base = {
			stdinIsTTY: true,
			stdoutIsTTY: true,
			quietStartup: false,
			env: {},
		};

		expect(shouldShowOCSIDStartupSplash(base)).toBe(true);
		expect(shouldShowOCSIDStartupSplash({ ...base, stdinIsTTY: false })).toBe(false);
		expect(shouldShowOCSIDStartupSplash({ ...base, stdoutIsTTY: false })).toBe(false);
		expect(shouldShowOCSIDStartupSplash({ ...base, quietStartup: true })).toBe(false);
		expect(shouldShowOCSIDStartupSplash({ ...base, quietStartup: true, verbose: true })).toBe(true);
	});

	it("honors explicit splash and benchmark disable flags", () => {
		const base = {
			stdinIsTTY: true,
			stdoutIsTTY: true,
			quietStartup: false,
		};

		expect(shouldShowOCSIDStartupSplash({ ...base, env: { OCSID_NO_SPLASH: "1" } })).toBe(false);
		expect(shouldShowOCSIDStartupSplash({ ...base, env: { OCSID_NO_SPLASH: "true" } })).toBe(false);
		expect(shouldShowOCSIDStartupSplash({ ...base, env: { OCSID_STARTUP_BENCHMARK: "yes" } })).toBe(false);
		expect(shouldShowOCSIDStartupSplash({ ...base, env: { OCSID_NO_SPLASH: "0" } })).toBe(true);
	});

	it("reflows when the terminal width changes without exceeding the viewport", () => {
		const splash = new OCSIDSplash("0.2.0");
		const narrow = splash.render(24);
		const wide = splash.render(120);

		expect(narrow.join("\n")).toContain("ocsid");
		expect(formatStartupTagline("0.2.0")).toContain("chemistry · molecules · drug discovery");
		expect(wide.length).toBeGreaterThan(narrow.length);
		expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
		expect(wide.every((line) => visibleWidth(line) <= 120)).toBe(true);

		const firstWideFrame = wide.join("\n");
		splash.nextFrame();
		expect(splash.render(120).join("\n")).not.toBe(firstWideFrame);
	});

	it("clears animation timers after normal completion", async () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const animation = animateOCSIDSplash(new OCSIDSplash("0.2.0"), requestRender, {
			frameMs: 10,
			durationMs: 50,
		});

		await vi.advanceTimersByTimeAsync(50);
		await expect(animation).resolves.toBe("completed");
		expect(requestRender).toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels immediately and clears timers during a quick exit", async () => {
		vi.useFakeTimers();
		const abortController = new AbortController();
		const animation = animateOCSIDSplash(new OCSIDSplash("0.2.0"), vi.fn(), {
			signal: abortController.signal,
			frameMs: 10,
			durationMs: 10_000,
		});

		await vi.advanceTimersByTimeAsync(20);
		abortController.abort();
		await expect(animation).resolves.toBe("aborted");
		expect(vi.getTimerCount()).toBe(0);
	});
});
