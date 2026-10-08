export type OcsidAgentMode = "creator" | "researcher";

export const DEFAULT_OCSID_AGENT_MODE: OcsidAgentMode = "researcher";

export interface OcsidAgentModeResolution {
	mode: OcsidAgentMode;
	invalidValue?: unknown;
}

export interface OcsidAgentModeCommand {
	mode: OcsidAgentMode;
	hasArguments: boolean;
}

export function isOcsidAgentMode(value: unknown): value is OcsidAgentMode {
	return value === "creator" || value === "researcher";
}

export function resolveOcsidAgentMode(value: unknown): OcsidAgentModeResolution {
	if (value === undefined) {
		return { mode: DEFAULT_OCSID_AGENT_MODE };
	}
	if (isOcsidAgentMode(value)) {
		return { mode: value };
	}
	return { mode: DEFAULT_OCSID_AGENT_MODE, invalidValue: value };
}

export function formatOcsidAgentMode(mode: OcsidAgentMode): string {
	return mode === "creator" ? "Creator" : "Researcher";
}

export function parseOcsidAgentModeCommand(value: string): OcsidAgentModeCommand | undefined {
	const match = /^\/(creator|researcher)(?:\s+([\s\S]+))?$/.exec(value);
	if (!match || !isOcsidAgentMode(match[1])) {
		return undefined;
	}
	return { mode: match[1], hasArguments: match[2] !== undefined };
}
