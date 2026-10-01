import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import { createRepoSkillObserverExtension } from "./repo-skill-observer/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{
		name: "repo-skill-observer",
		factory: createRepoSkillObserverExtension,
		hidden: true,
	},
];
