/**
 * Outbound-URL guard for the research web tools (SSRF containment).
 *
 * `web_search`/`web_fetch` are model-driven: the fetcher chooses the URL, and the
 * model's choice is steerable by anything it has read — a repository file, a
 * fetched page, a search result, a skill. Without a guard, a fetch is an
 * arbitrary network request issued FROM the user's machine, which turns
 * prompt injection into a request-forgery primitive:
 *
 *   - cloud instance metadata (`http://169.254.169.254/...`) hands out the
 *     instance role's temporary credentials on AWS/GCP/Azure/DO,
 *   - `http://127.0.0.1:<port>` reaches local admin panels, dev servers, the
 *     OCSID OAuth loopback listeners, and other users' localhost services,
 *   - RFC1918/ULA addresses reach the user's private network.
 *
 * A public URL that 302s to one of those is the same attack, so redirects are
 * followed manually here and every hop is validated — `redirect: "follow"`
 * would let a host the guard approved bounce the request inward.
 *
 * This is not a rebinding-proof egress filter: the hostname is resolved and
 * checked, then fetched by name, so a hostile resolver that answers public for
 * the check and private for the fetch can still slip through. Closing that
 * needs a pinned-IP connector, which the shared fetch dispatcher does not
 * expose. Everything reachable by a single URL or a normal redirect is closed.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames that never leave the machine, regardless of what DNS says. */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export const MAX_REDIRECTS = 5;

/** Parse an IPv4 literal into its four octets, or return undefined. */
function parseIpv4(address: string): [number, number, number, number] | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map((part) => Number(part));
	if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
	return octets as [number, number, number, number];
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or return undefined when
 * it is not well-formed. Handles `::` compression and a trailing dotted-quad
 * (`::ffff:127.0.0.1`), so every spelling of an address decodes to the same
 * values.
 */
function expandIpv6(address: string): number[] | undefined {
	let text = address;

	// A trailing dotted-quad contributes two groups.
	const dotted = text.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (dotted) {
		const octets = parseIpv4(dotted[2]);
		if (!octets) return undefined;
		text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}

	const halves = text.split("::");
	if (halves.length > 2) return undefined;

	const parseGroups = (part: string): number[] | undefined => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const group of part.split(":")) {
			if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
			groups.push(Number.parseInt(group, 16));
		}
		return groups;
	};

	const left = parseGroups(halves[0] ?? "");
	if (left === undefined) return undefined;
	if (halves.length === 1) return left.length === 8 ? left : undefined;

	const right = parseGroups(halves[1] ?? "");
	if (right === undefined) return undefined;
	const missing = 8 - left.length - right.length;
	if (missing < 1) return undefined;
	return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/**
 * Recover the IPv4 address carried inside an IPv6 literal, when there is one.
 *
 * Several notations embed an IPv4 address in an IPv6 literal — `::ffff:a.b.c.d`
 * (IPv4-mapped, `::ffff:0:0/96`), `::a.b.c.d` (IPv4-compatible, `::/96`),
 * `64:ff9b::a.b.c.d` (NAT64, `64:ff9b::/96`) and `2002:a.b.c.d::` (6to4,
 * `2002::/16`) — and each one also has a pure-hex spelling with no dots at all
 * (`::ffff:7f00:1` is 127.0.0.1, `::ffff:a9fe:a9fe` is 169.254.169.254). A check
 * that only pattern-matches the dotted form lets the hex spelling through, so
 * decode by group value instead and judge the IPv4 address it denotes.
 *
 * Returns a dotted-quad string, or undefined when the literal carries no IPv4.
 */
function embeddedIpv4(groups: number[]): string | undefined {
	const ipv4Of = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
	const zeros = (from: number, to: number): boolean => groups.slice(from, to).every((group) => group === 0);

	// The three prefixes that carry the IPv4 address in the final 32 bits differ
	// only in which leading groups hold the 0xffff marker:
	//   ::/96                 IPv4-compatible
	//   ::ffff:0:0/96         IPv4-mapped
	//   ::ffff:0:0:0/96       IPv4-translated
	if (zeros(0, 6)) return ipv4Of(groups[6], groups[7]);
	if (zeros(0, 5) && groups[5] === 0xffff) return ipv4Of(groups[6], groups[7]);
	if (zeros(0, 4) && groups[4] === 0xffff) return ipv4Of(groups[6], groups[7]);
	// NAT64 well-known prefix 64:ff9b::/96
	if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) {
		return ipv4Of(groups[6], groups[7]);
	}
	// 6to4 2002::/16 carries the address in the two groups after the prefix.
	if (groups[0] === 0x2002) return ipv4Of(groups[1], groups[2]);
	return undefined;
}

/**
 * True for addresses that are not globally routable: loopback, private,
 * link-local (which covers cloud metadata), CGNAT, unspecified, multicast,
 * reserved, and the IPv6 equivalents.
 */
export function isBlockedAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) {
		const octets = parseIpv4(address);
		if (!octets) return true;
		const [a, b] = octets;
		if (a === 0) return true; // 0.0.0.0/8 "this network"
		if (a === 10) return true; // RFC1918
		if (a === 127) return true; // loopback
		if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
		if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
		if (a === 192 && b === 168) return true; // RFC1918
		if (a === 192 && b === 0) return true; // IETF protocol assignments
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
		if (a >= 224) return true; // multicast + reserved + broadcast
		return false;
	}

	if (version === 6) {
		// Judge by decoded group values, not string prefixes: the checks below
		// then hold for every spelling (`fe80::1` and `0:0:0:0:0:fe80:1`) and the
		// embedded-IPv4 forms are reached however the address is written.
		const groups = expandIpv6(address);
		if (groups === undefined) return true; // unparseable -> treat as unsafe

		// An IPv4-mapped/translated/compatible address is only as safe as the
		// IPv4 address it carries, whatever notation spelled it.
		const embedded = embeddedIpv4(groups);
		if (embedded !== undefined) return isBlockedAddress(embedded);

		const first = groups[0];
		if (groups.every((group) => group === 0)) return true; // :: unspecified
		if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1 loopback
		if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
		if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
		if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
		return false;
	}

	return true;
}

function isBlockedHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	// A trailing dot is the same name to DNS but a different string to a
	// suffix check, so normalize before comparing.
	const bare = host.endsWith(".") ? host.slice(0, -1) : host;
	if (bare === "localhost" || bare.endsWith(".localhost")) return true;
	return BLOCKED_HOST_SUFFIXES.some((suffix) => bare.endsWith(suffix));
}

/** Resolves a hostname to every address it answers with. Injectable for tests. */
export type HostResolver = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultResolver: HostResolver = (hostname) => lookup(hostname, { all: true });

/**
 * Validate one URL. Throws with a user-facing reason when the URL may not be
 * fetched. Async because a DNS name has to be resolved to judge it.
 */
export async function assertFetchableUrl(rawUrl: string, resolve: HostResolver = defaultResolver): Promise<URL> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`refusing to fetch "${rawUrl}": not a valid absolute URL`);
	}

	if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
		throw new Error(
			`refusing to fetch "${rawUrl}": only http:// and https:// URLs are fetched (got "${url.protocol}//")`,
		);
	}

	// `http://user:pass@host/` smuggles credentials into the request line and
	// `http://host\t.evil/` has been used to desync parsers; neither is needed.
	if (url.username || url.password) {
		throw new Error(`refusing to fetch "${rawUrl}": URLs with embedded credentials are not fetched`);
	}

	// WHATWG URL keeps the brackets on an IPv6 literal (`[::1]`), and `net.isIP`
	// does not accept them — leaving them on would skip the literal check and
	// hand a bracketed string to the resolver.
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (isBlockedHostname(hostname)) {
		throw new Error(`refusing to fetch "${rawUrl}": "${hostname}" is a local hostname`);
	}

	if (isIP(hostname)) {
		if (isBlockedAddress(hostname)) {
			throw new Error(
				`refusing to fetch "${rawUrl}": "${hostname}" is a loopback, private, link-local, or reserved address`,
			);
		}
		return url;
	}

	let addresses: Array<{ address: string }>;
	try {
		addresses = await resolve(hostname);
	} catch (error) {
		throw new Error(
			`refusing to fetch "${rawUrl}": could not resolve host "${hostname}" (${error instanceof Error ? error.message : error})`,
		);
	}
	if (addresses.length === 0) {
		throw new Error(`refusing to fetch "${rawUrl}": host "${hostname}" did not resolve to any address`);
	}
	// Every answer must be public: one private answer is enough for a resolver
	// to steer the fetch inward.
	const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
	if (blocked) {
		throw new Error(
			`refusing to fetch "${rawUrl}": host "${hostname}" resolves to the non-public address ${blocked.address}`,
		);
	}

	return url;
}

/**
 * fetch() with every hop validated. Follows up to MAX_REDIRECTS redirects
 * manually so a public URL cannot bounce the request into a blocked address.
 */
export async function guardedFetch(
	url: string,
	init: RequestInit & { signal?: AbortSignal },
	resolve: HostResolver = defaultResolver,
): Promise<Response> {
	let current = await assertFetchableUrl(url, resolve);

	for (let hop = 0; ; hop++) {
		const response = await fetch(current, { ...init, redirect: "manual" });

		const isRedirect = response.status >= 300 && response.status < 400;
		const location = response.headers.get("location");
		if (!isRedirect || !location) {
			return response;
		}
		if (hop >= MAX_REDIRECTS) {
			throw new Error(`refusing to follow more than ${MAX_REDIRECTS} redirects (last from ${current.href})`);
		}

		// Resolve relative Location values against the URL that produced them,
		// then re-validate before the next request.
		const next = new URL(location, current).href;
		current = await assertFetchableUrl(next, resolve);
	}
}
