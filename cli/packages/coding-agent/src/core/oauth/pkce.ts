/**
 * PKCE utilities using Web Crypto API.
 * Works in both Node.js 20+ and browsers.
 */

/**
 * Encode bytes as base64url string.
 */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Generate PKCE code verifier and challenge.
 * Uses Web Crypto API for cross-platform compatibility.
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// Generate random verifier
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// Compute SHA-256 challenge
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}

/**
 * Generate an independent OAuth `state` value.
 *
 * The state must never be derived from the PKCE verifier. The state travels in
 * the authorize URL and is therefore visible in browser history, `Referer`
 * headers, and any proxy log on the path, whereas PKCE only holds if the
 * verifier stays secret until the token exchange. Reusing the verifier as the
 * state exposes it to everyone who can observe that URL.
 */
export function generateOAuthState(): string {
	const stateBytes = new Uint8Array(16);
	crypto.getRandomValues(stateBytes);
	return base64urlEncode(stateBytes);
}
