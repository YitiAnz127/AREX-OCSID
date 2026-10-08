import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";

const OCSID_SPLASH_FRAMES = [
	"o     ",
	" o    ",
	"  o   ",
	"   o  ",
	"    o ",
	"     o",
	"    o ",
	"   o  ",
	"  o   ",
	" o    ",
];

export const OCSID_SPLASH_FRAME_MS = 80;
export const OCSID_SPLASH_DURATION_MS = 880;

const OCSID_DANCER_PIXEL_WIDTH = 9;
const OCSID_DANCER_PIXEL = "█";
const OCSID_DANCER_EMPTY_PIXEL = " ";
const OCSID_SIDE_GAP = "    ";

export const OCSID_COLORS = {
	forest: "#36663E",
	olive: "#889F4E",
	moss: "#C4C248",
	gold: "#F8D042",
	amber: "#F9B43F",
} as const;

const OCSID_LOGO_PALETTE = [
	OCSID_COLORS.forest,
	OCSID_COLORS.olive,
	OCSID_COLORS.moss,
	OCSID_COLORS.gold,
	OCSID_COLORS.amber,
] as const;

const OCSID_DANCER_FRAMES = [
	["..s...s..", ".s.hhh.s.", "...hss...", "...ttt...", "..sttts..", "...ppp...", "..p...p..", ".ww...ww."],
	[".s.....s.", "..shhh.s.", "..hss....", "...ttts..", "..sttd...", "..ppp....", ".p...p...", "ww....ww."],
	[".s.....s.", "s..hhh..s", ".s.hssh.s", "...ttt...", "..sttts..", "..ppppp..", ".p.....p.", "ww.....ww"],
	[".s.....s.", ".s.hhh.s.", "....ssh..", "..sttt...", "...dtts..", "....ppp..", "...p...p.", ".ww....ww"],
] as const;

const OCSID_LOGO_LINES = [
	" ██████╗  ██████╗███████╗██╗██████╗ ",
	"██╔═══██╗██╔════╝██╔════╝██║██╔══██╗",
	"██║   ██║██║     ███████╗██║██║  ██║",
	"██║   ██║██║     ╚════██║██║██║  ██║",
	"╚██████╔╝╚██████╗███████║██║██████╔╝",
	" ╚═════╝  ╚═════╝╚══════╝╚═╝╚═════╝ ",
];

const OCSID_LOGO_WIDTH = Math.max(...OCSID_LOGO_LINES.map((line) => visibleWidth(line)));
const OCSID_WIDE_SCENE_WIDTH =
	OCSID_DANCER_PIXEL_WIDTH * visibleWidth(OCSID_DANCER_PIXEL) * 2 +
	OCSID_SIDE_GAP.length * 2 +
	OCSID_LOGO_WIDTH;

const OCSID_DANCER_PALETTES = {
	left: {
		d: OCSID_COLORS.forest,
		h: OCSID_COLORS.forest,
		s: OCSID_COLORS.gold,
		t: OCSID_COLORS.amber,
		p: OCSID_COLORS.moss,
		w: OCSID_COLORS.gold,
	},
	right: {
		d: OCSID_COLORS.forest,
		h: OCSID_COLORS.olive,
		s: OCSID_COLORS.gold,
		t: OCSID_COLORS.moss,
		p: OCSID_COLORS.amber,
		w: OCSID_COLORS.gold,
	},
} as const;

type OCSIDDancerSide = keyof typeof OCSID_DANCER_PALETTES;
type OCSIDDancerSymbol = keyof (typeof OCSID_DANCER_PALETTES)["left"];

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function shouldShowOCSIDStartupSplash(options: {
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	verbose?: boolean;
	quietStartup: boolean;
	env?: NodeJS.ProcessEnv;
}): boolean {
	const env = options.env ?? process.env;
	return (
		options.stdinIsTTY &&
		options.stdoutIsTTY &&
		!isTruthyEnvFlag(env.OCSID_NO_SPLASH) &&
		!isTruthyEnvFlag(env.OCSID_STARTUP_BENCHMARK) &&
		(options.verbose === true || !options.quietStartup)
	);
}

export function ocsidFg(color: string, text: string): string {
	return chalk.hex(color)(text);
}

export function ocsidBold(color: string, text: string): string {
	return chalk.bold(ocsidFg(color, text));
}

function logoPaletteColor(position: number): string {
	const clamped = Math.max(0, Math.min(1, position));
	const index = Math.min(Math.round(clamped * (OCSID_LOGO_PALETTE.length - 1)), OCSID_LOGO_PALETTE.length - 1);
	return OCSID_LOGO_PALETTE[index] ?? OCSID_COLORS.forest;
}

export function formatStartupTagline(version: string): string {
	return `${ocsidBold(OCSID_COLORS.gold, "ocsid")} ${ocsidFg(OCSID_COLORS.moss, `v${version}`)} ${ocsidFg(OCSID_COLORS.olive, "· chemistry · molecules · drug discovery")}`;
}

function renderDancerRow(row: string, side: OCSIDDancerSide): string {
	const palette = OCSID_DANCER_PALETTES[side];
	let rendered = "";
	for (const rawSymbol of row.padEnd(OCSID_DANCER_PIXEL_WIDTH, ".").slice(0, OCSID_DANCER_PIXEL_WIDTH)) {
		if (rawSymbol === ".") {
			rendered += OCSID_DANCER_EMPTY_PIXEL;
			continue;
		}
		const symbol = rawSymbol as OCSIDDancerSymbol;
		rendered += ocsidFg(palette[symbol] ?? OCSID_COLORS.gold, OCSID_DANCER_PIXEL);
	}
	return rendered;
}

function dancerLines(frame: number, side: OCSIDDancerSide): string[] {
	const pose = OCSID_DANCER_FRAMES[frame % OCSID_DANCER_FRAMES.length] ?? OCSID_DANCER_FRAMES[0];
	return pose.map((row) => renderDancerRow(row, side));
}

export function ocsidSceneContentWidth(terminalWidth: number): number {
	return Math.max(1, terminalWidth - 4);
}

export function centerText(text: string, width: number): string {
	const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
	return `${" ".repeat(padding)}${text}`;
}

function tintLogoLine(line: string, row: number): string {
	let tinted = "";
	const chars = [...line];
	const rowRatio = OCSID_LOGO_LINES.length <= 1 ? 0 : row / (OCSID_LOGO_LINES.length - 1);
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i] ?? "";
		const columnRatio = chars.length <= 1 ? 0 : i / (chars.length - 1);
		const color = logoPaletteColor(columnRatio * 0.88 + rowRatio * 0.12);
		tinted += ch === " " ? " " : ocsidFg(color, ch);
	}
	return tinted;
}

export function formatOCSIDScene(frame: number, terminalWidth = process.stdout.columns || 120): string[] {
	const contentWidth = ocsidSceneContentWidth(terminalWidth);
	if (contentWidth < OCSID_LOGO_WIDTH) {
		const compactLogo = truncateToWidth(ocsidBold(OCSID_COLORS.gold, "ocsid"), contentWidth, "");
		return [centerText(compactLogo, contentWidth)];
	}

	const logo = OCSID_LOGO_LINES.map((line, row) => centerText(tintLogoLine(line, row), contentWidth));
	if (contentWidth < OCSID_WIDE_SCENE_WIDTH) {
		return logo;
	}

	const leftDancer = dancerLines(frame, "left");
	const rightDancer = dancerLines(frame + 1, "right");
	const logoTop = Math.floor((leftDancer.length - OCSID_LOGO_LINES.length) / 2);
	return leftDancer.map((left, row) => {
		const logoIndex = row - logoTop;
		const rawLogo = OCSID_LOGO_LINES[logoIndex] ?? "";
		const renderedLogo = rawLogo ? tintLogoLine(rawLogo, logoIndex) : " ".repeat(OCSID_LOGO_WIDTH);
		const right = rightDancer[row] ?? " ".repeat(OCSID_DANCER_PIXEL_WIDTH);
		return centerText(`${left}${OCSID_SIDE_GAP}${renderedLogo}${OCSID_SIDE_GAP}${right}`, contentWidth);
	});
}

export function formatOCSIDSplash(version: string, sweep: string, frame: number, terminalWidth: number): string {
	const contentWidth = ocsidSceneContentWidth(terminalWidth);
	const fullTagline = formatStartupTagline(version);
	const compactTagline = `${ocsidBold(OCSID_COLORS.gold, "ocsid")} ${ocsidFg(OCSID_COLORS.moss, `v${version}`)}`;
	const tagline = visibleWidth(fullTagline) <= contentWidth ? fullTagline : compactTagline;
	const status = visibleWidth(tagline) + 2 <= contentWidth ? `${ocsidFg(OCSID_COLORS.amber, sweep)} ${tagline}` : tagline;
	return [...formatOCSIDScene(frame, terminalWidth), "", centerText(truncateToWidth(status, contentWidth, ""), contentWidth)].join(
		"\n",
	);
}

export class OCSIDSplash implements Component {
	private frame = 0;
	private readonly version: string;

	constructor(version: string) {
		this.version = version;
	}

	nextFrame(): void {
		this.frame = (this.frame + 1) % OCSID_SPLASH_FRAMES.length;
	}

	render(width: number): string[] {
		const sweep = OCSID_SPLASH_FRAMES[this.frame] ?? OCSID_SPLASH_FRAMES[0];
		return formatOCSIDSplash(this.version, sweep, this.frame, width).split("\n");
	}

	invalidate(): void {}
}

export async function animateOCSIDSplash(
	splash: OCSIDSplash,
	requestRender: () => void,
	options: { signal?: AbortSignal; frameMs?: number; durationMs?: number } = {},
): Promise<"completed" | "aborted"> {
	const signal = options.signal;
	if (signal?.aborted) return "aborted";

	let finish: ((result: "completed" | "aborted") => void) | undefined;
	const result = new Promise<"completed" | "aborted">((resolve) => {
		finish = resolve;
	});
	const interval = setInterval(() => {
		splash.nextFrame();
		requestRender();
	}, options.frameMs ?? OCSID_SPLASH_FRAME_MS);
	const timeout = setTimeout(() => finish?.("completed"), options.durationMs ?? OCSID_SPLASH_DURATION_MS);
	const onAbort = () => finish?.("aborted");
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		return await result;
	} finally {
		clearInterval(interval);
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}
