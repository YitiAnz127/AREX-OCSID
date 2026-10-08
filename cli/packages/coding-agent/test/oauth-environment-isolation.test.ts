import type { AuthContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	anthropicOAuth,
	createOcsidProviderAuthContext,
	getOcsidOAuthCallbackHost,
	openaiCodexOAuth,
	openRouterOAuth,
} from "../src/core/oauth/index.ts";

describe("OAuth environment isolation", () => {
	it("uses only the OCSID callback-host variable", () => {
		// The sentinel must be a loopback literal: getOcsidOAuthCallbackHost
		// refuses anything else so the OAuth callback cannot be published to the
		// network. `::1` is distinct from the `127.0.0.1` default, so it still
		// proves the OCSID variable is honoured rather than ignored.
		expect(getOcsidOAuthCallbackHost({ PI_OAUTH_CALLBACK_HOST: "pi.internal" })).toBe("127.0.0.1");
		expect(
			getOcsidOAuthCallbackHost({
				PI_OAUTH_CALLBACK_HOST: "pi.internal",
				OCSID_OAUTH_CALLBACK_HOST: "::1",
			}),
		).toBe("::1");
	});

	it("refuses a non-loopback callback host before it can be listened on", () => {
		// Binding 0.0.0.0 does not mean localhost: it accepts the OAuth redirect,
		// authorization code included, from every interface.
		for (const host of ["0.0.0.0", "ocsid.internal", "192.168.1.10"]) {
			expect(() => getOcsidOAuthCallbackHost({ OCSID_OAUTH_CALLBACK_HOST: host }), host).toThrow(
				/loopback address/i,
			);
		}
	});

	it("filters every PI_* lookup from provider auth contexts", async () => {
		const reads: string[] = [];
		const base: AuthContext = {
			env: async (name) => {
				reads.push(name);
				return `${name}-value`;
			},
			fileExists: async () => true,
		};
		const context = createOcsidProviderAuthContext(base);

		await expect(context.env("PI_OAUTH_CALLBACK_HOST")).resolves.toBeUndefined();
		await expect(context.env("PI_CODING_AGENT_DIR")).resolves.toBeUndefined();
		await expect(context.env("ANTHROPIC_API_KEY")).resolves.toBe("ANTHROPIC_API_KEY-value");
		expect(reads).toEqual(["ANTHROPIC_API_KEY"]);
		await expect(context.fileExists("/tmp/credential")).resolves.toBe(true);
	});

	it("replaces the three callback-based Pi OAuth flows in ModelRuntime", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });

		expect(runtime.getProvider("anthropic")?.auth.oauth).toBe(anthropicOAuth);
		expect(runtime.getProvider("openai-codex")?.auth.oauth).toBe(openaiCodexOAuth);
		expect(runtime.getProvider("openrouter")?.auth.oauth).toBe(openRouterOAuth);
	});
});
