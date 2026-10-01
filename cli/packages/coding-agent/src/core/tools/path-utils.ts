import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";

const NARROW_NO_BREAK_SPACE = "\u202F";

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Returns true when a path (relative to a search/workspace root) escapes that
 * root. Used for P0-02 containment: directory-listing/globbing tools must never
 * surface a result that climbs above their search root (reachable only through
 * a symlink traversal), so escaping paths are dropped rather than reported.
 * An empty string (the root itself) and any plain in-root child are contained.
 */
export function isEscapingRelative(relativePath: string): boolean {
	if (isAbsolute(relativePath)) return true;
	// Track directory depth across both separators (rg/fd can emit POSIX or
	// Windows forms regardless of host). A path that climbs above the root at
	// any point — even a mid-path "a/../.." — escapes.
	let depth = 0;
	for (const segment of relativePath.replace(/\\/g, "/").split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			depth--;
			if (depth < 0) return true;
		} else {
			depth++;
		}
	}
	return false;
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 *
 * P2-05 (DEFERRED, audit F1): resolution here is purely lexical (node:path),
 * with NO realpath canonicalization or workspace containment. A symlink inside
 * the workspace that points outside is followed verbatim by write/edit/read.
 * A proper fix must canonicalize the deepest existing ancestor of the resolved
 * path and verify it stays inside the real cwd, while PRESERVING explicit
 * absolute paths outside cwd (documented behavior for read/edit/ls). Deferred
 * because it touches every tool's hot path (per-op realpath cost), needs
 * careful depth-canonicalization for not-yet-existing write targets, and risks
 * regressing the live editor tools. F2 (extensions symlink RCE) is the fixed
 * subset of this same defect class.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);

	if (await pathExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
		return nfdCurlyVariant;
	}

	return resolved;
}
