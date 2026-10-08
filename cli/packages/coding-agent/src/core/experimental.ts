// Accept any of "1"/"true"/"yes" (case-insensitive) — mirror the truthy-flag
// handling used by the other OCSID_* feature toggles so a natural
// OCSID_EXPERIMENTAL=true is not silently ignored (audit H4).
function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function areExperimentalFeaturesEnabled(): boolean {
	return isTruthyEnvFlag(process.env.OCSID_EXPERIMENTAL);
}
