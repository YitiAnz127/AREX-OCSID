import { sanitizeBinaryOutput } from "../../../utils/shell.ts";

/**
 * Strip terminal control characters from text that originates outside the
 * renderer before it is handed to a pi-tui `Text` or `Markdown` component.
 *
 * pi-tui does not filter control characters on the way out — its terminal
 * `write()` is a bare `process.stdout.write(data)` — so any ESC byte that
 * survives into a rendered string is interpreted by the user's terminal:
 *
 *   - `OSC 52` writes the clipboard, so a poisoned session can leave an
 *     attacker-chosen command on the clipboard for the user to paste,
 *   - `OSC 0`/`OSC 2` spoof the window title,
 *   - CSI sequences can move the cursor or repaint the screen and fake output.
 *
 * The sources are not under the user's control: a repository's `SKILL.md`, a
 * model response steered by that repository, and a session file handed over by
 * someone else all reach these components. `sanitizeBinaryOutput` keeps tabs and
 * newlines and drops the rest of the control ranges, so legitimate formatting
 * survives while escape sequences do not.
 */
export function sanitizeForDisplay(text: string): string {
	return sanitizeBinaryOutput(text);
}
