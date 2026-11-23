import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/headless";
import { RESET_INPUT_MODES, resetInputModes } from "./inputModes";

/**
 * The garbled UI Agent terminal, with xterm's own parser and synthetic
 * output: a saved Claude Code session turns mouse tracking on and is cut
 * off before it turns it off; on cold restore that output is replayed and
 * a new shell starts in the same terminal.
 */

const write = (term: Terminal, data: string) =>
	new Promise<void>((done) => term.write(data, done));

/** What Claude Code's TUI sends at start (synthetic): modes, colours, text. */
const SAVED_CLAUDE_OUTPUT = [
	"\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h", // mouse tracking, SGR
	"\x1b[?1004h", // focus reporting
	"\x1b[?2004h", // bracketed paste
	"\x1b[38;2;215;119;87m✻\x1b[0m Welcome to Claude Code — 日本語 ok\r\n",
	"\x1b[2K\x1b[1G\x1b[38;5;246m> \x1b[0m",
].join("");

function mouseReportsSent(term: Terminal): string[] {
	const sent: string[] = [];
	term.onData((data) => sent.push(data));
	return sent;
}

describe("replayed terminal output", () => {
	it("leaves mouse tracking on without the fix: a new shell would get mouse reports as input", async () => {
		const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
		await write(term, SAVED_CLAUDE_OUTPUT);
		expect(term.modes.mouseTrackingMode).toBe("any");
		expect(term.modes.sendFocusMode).toBe(true);
		term.dispose();
	});

	it("after the reset, input reporting is off while colours, Unicode and text stay", async () => {
		const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
		await write(term, SAVED_CLAUDE_OUTPUT);
		resetInputModes(term);
		await write(term, "");
		expect(term.modes.mouseTrackingMode).toBe("none");
		expect(term.modes.sendFocusMode).toBe(false);
		expect(term.modes.bracketedPasteMode).toBe(false);
		expect(term.modes.applicationCursorKeysMode).toBe(false);
		// The replayed text and its colours are untouched.
		const line = term.buffer.active.getLine(0);
		expect(line?.translateToString(true)).toBe(
			"✻ Welcome to Claude Code — 日本語 ok",
		);
		const cell = line?.getCell(0);
		expect(cell?.isFgRGB()).toBe(true);
		expect(cell?.getFgColor()).toBe((215 << 16) | (119 << 8) | 87);
		// Nothing is sent to the shell by resetting.
		const sent = mouseReportsSent(term);
		resetInputModes(term);
		await write(term, "");
		expect(sent).toEqual([]);
		term.dispose();
	});

	it("only input modes are reset: the alternate screen and cursor movement are left alone", async () => {
		const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
		await write(term, "\x1b[?1049h\x1b[3;5Hx");
		resetInputModes(term);
		await write(term, "");
		expect(term.buffer.active.type).toBe("alternate");
		expect(term.buffer.active.cursorY).toBe(2);
		expect(RESET_INPUT_MODES).not.toContain("1049");
		expect(RESET_INPUT_MODES).not.toContain("[0m");
		term.dispose();
	});
});
