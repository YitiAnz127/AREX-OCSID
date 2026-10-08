import { compare, valid } from "semver";
import { PACKAGE_NAME } from "../config.ts";
import { getOcsidUserAgent } from "./ocsid-user-agent.ts";

/**
 * Derived from the running package name so a rebrand cannot silently point the
 * version check, and the `update --self` target built from its result, at a
 * different npm package.
 */
const DEFAULT_LATEST_VERSION_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestOcsidRelease {
	version: string;
	note?: string;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestOcsidRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestOcsidRelease | undefined> {
	if (process.env.OCSID_OFFLINE) return undefined;

	const response = await fetch(process.env.OCSID_LATEST_VERSION_URL || DEFAULT_LATEST_VERSION_URL, {
		headers: {
			"User-Agent": getOcsidUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		...(note ? { note } : {}),
	};
}

export async function getLatestOcsidVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestOcsidRelease(currentVersion, options))?.version;
}

export async function checkForNewOcsidVersion(currentVersion: string): Promise<LatestOcsidRelease | undefined> {
	if (process.env.OCSID_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestOcsidRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
