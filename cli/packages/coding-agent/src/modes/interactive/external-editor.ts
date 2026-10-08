import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

/**
 * Characters `cmd.exe` treats as command separators, redirection, or its escape
 * character. The editor command is split on spaces and, on Windows, handed to
 * `spawn` with `shell: true` — which is what lets an editor path containing
 * spaces work despite that naive split, but also means these characters are
 * re-parsed as shell syntax. The value can come from a project's
 * `.ocsid/settings.json`, and the trust prompt never discloses that it is
 * shell-parsed, so a value carrying them is refused rather than executed.
 *
 * Deliberately excluded: `(` and `)`, which appear in the common Windows path
 * `C:\Program Files (x86)\…`; `!`, which only acts under cmd's delayed expansion
 * (off by default); and other characters that cannot introduce a second command.
 */
const WINDOWS_SHELL_METACHARACTERS = /[&|<>^%]/;

function resolveEditorCommand(command: string): { editor: string; editorArgs: string[] } | undefined {
	if (process.platform === "win32" && WINDOWS_SHELL_METACHARACTERS.test(command)) {
		return undefined;
	}
	const [editor, ...editorArgs] = command.split(" ");
	if (!editor) {
		return undefined;
	}
	return { editor, editorArgs };
}

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const resolved = resolveEditorCommand(options.command);
		if (!resolved) {
			process.stderr.write(`Refusing to launch external editor: ${options.command}\n`);
			return { status: "failed" };
		}
		const { editor, editorArgs } = resolved;
		process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: readFileSync(filePath, "utf-8").replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
