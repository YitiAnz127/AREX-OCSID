const DEFAULT_OAUTH_CALLBACK_HOST = "127.0.0.1";

/**
 * Hosts that keep the OAuth callback listener on the machine. `localhost` is
 * included because it is what the advertised redirect_uri uses; the listener
 * binds the literal so a dual-stack `localhost` cannot resolve away from it.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Resolve OCSID's loopback OAuth listener without consulting Pi-owned state.
 *
 * OCSID_OAUTH_CALLBACK_HOST exists for environments where the browser reaches
 * the CLI through a forwarded port (a container, a remote shell), but the value
 * is used verbatim as a listen() address. `0.0.0.0` there is not "localhost" —
 * it binds every interface, so the authorization code is delivered to whichever
 * host on the network asks first, and OpenRouter additionally advertises that
 * address as the redirect target over plaintext http. Rejecting anything that is
 * not a loopback literal keeps the escape hatch for port-forwarding setups while
 * refusing to publish the callback to the network.
 */
export function getOcsidOAuthCallbackHost(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.OCSID_OAUTH_CALLBACK_HOST?.trim();
	if (!configured) {
		return DEFAULT_OAUTH_CALLBACK_HOST;
	}

	// A bracketed IPv6 literal (`[::1]`) is not a valid listen() address.
	const host = configured.replace(/^\[|\]$/g, "");
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(
			`OCSID_OAUTH_CALLBACK_HOST must be a loopback address (127.0.0.1, ::1, or localhost) so the OAuth callback is not exposed to the network; got ${JSON.stringify(configured)}.`,
		);
	}
	return host === "localhost" ? DEFAULT_OAUTH_CALLBACK_HOST : host;
}
