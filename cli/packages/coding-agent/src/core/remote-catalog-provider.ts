import type { Api, Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import { getDiscoUserAgent } from "../utils/disco-user-agent.ts";

export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

function mergeModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

function parseCatalog(providerId: string, value: unknown): Model<Api>[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return entries
		.filter((entry): entry is Model<Api> => typeof entry === "object" && entry !== null && "id" in entry)
		.map((model) => ({ ...model, provider: providerId }));
}

function remoteModels(
	entry: ModelsStoreEntry | undefined,
	localGeneratedAt: number | undefined,
): readonly Model<Api>[] {
	if (!entry) return [];
	if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
		return [];
	}
	return entry.models;
}

/** Add an optional persisted remote catalog overlay to a static built-in provider. */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string | undefined = process.env.DISCO_MODEL_CATALOG_URL,
	localGeneratedAt?: number,
): Provider {
	if (!catalogBaseUrl) return provider;

	// Security gate (audit F1): the remote catalog can define arbitrary per-model
	// baseUrl/headers, and resolved API keys are streamed to whatever baseUrl the
	// selected model carries. Serving that over plaintext http:// would let any
	// network observer (or a MITM) redirect the user's key to an attacker host.
	// Require https and a parseable URL; fail loudly on insecure/malformed config
	// rather than silently proceeding. Note (P2-05 deferral): catalog-supplied
	// baseUrl/headers per model are still NOT allow-listed against the provider —
	// https enforcement closes the plaintext vector but a https catalog that is
	// itself compromised could still redirect keys; that residual trust surface is
	// deferred (allow-list design has compatibility implications with legit custom
	// gateway catalogs).
	const parsedCatalogUrl = new URL(catalogBaseUrl);
	if (parsedCatalogUrl.protocol !== "https:") {
		throw new Error(
			`Refusing to load remote model catalog: DISCO_MODEL_CATALOG_URL must use https:// (got "${parsedCatalogUrl.protocol}//") so that resolved API keys are never sent to an insecure endpoint.`,
		);
	}

	let dynamicModels: readonly Model<Api>[] = [];
	let inflightRefresh: Promise<void> | undefined;

	return {
		...provider,
		getModels: () => mergeModels(provider.getModels(), dynamicModels),
		refreshModels: (context) => {
			inflightRefresh ??= (async () => {
				try {
					const stored = await context.store.read();
					dynamicModels = remoteModels(stored, localGeneratedAt).filter((model) => model.provider === provider.id);
					if (!context.allowNetwork || context.signal?.aborted) return;
					if (
						!context.force &&
						stored?.checkedAt !== undefined &&
						stored.lastModified !== undefined &&
						Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
					) {
						return;
					}

					// Only revalidate when a cached body backs the validator, so a 304 can never
					// leave the overlay empty.
					const validator = stored?.models.length ? stored.etag : undefined;
					const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
					const response = await fetch(url, {
						headers: {
							accept: "application/json",
							"User-Agent": getDiscoUserAgent(VERSION),
							...(validator ? { "if-none-match": validator } : {}),
						},
						signal: context.signal,
					});
					if (context.signal?.aborted) return;
					const checkedAt = Date.now();
					// Unchanged: dynamicModels already holds the stored overlay, so only the
					// freshness window moves.
					if (response.status === 304 && stored) {
						await context.store.write({ ...stored, checkedAt });
						return;
					}
					if (response.status === 404 || response.status === 501) {
						await context.store.write({
							...(stored ?? { models: [] }),
							checkedAt,
							lastModified: 0,
							etag: undefined,
						});
						return;
					}
					if (!response.ok) {
						// Transient failure: the cached body and its validator stay valid, so keep the
						// etag and let the next refresh revalidate instead of downloading the catalog.
						await context.store.write({ ...(stored ?? { models: [] }), checkedAt });
						throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
					}
					const refreshed = parseCatalog(provider.id, await response.json());
					const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
					if (context.signal?.aborted) return;
					const entry = {
						models: refreshed,
						checkedAt,
						lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
						etag: response.headers.get("etag") ?? undefined,
					};
					dynamicModels = remoteModels(entry, localGeneratedAt);
					await context.store.write(entry);
				} finally {
					inflightRefresh = undefined;
				}
			})();
			return inflightRefresh;
		},
	};
}
