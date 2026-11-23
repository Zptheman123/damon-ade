/**
 * Terminal input-reporting modes, and how to switch them off.
 *
 * Programs like Claude Code turn on mouse tracking (DECSET 1000/1002/1003
 * with SGR encoding 1006), focus reporting (1004) and similar modes, and
 * turn them off when they exit. A cold restore replays a saved session's
 * output into the terminal, including those "on" switches but not always
 * the "off" ones (the program was still running when the app closed). The
 * terminal then keeps reporting the mouse to whatever runs next: a fresh
 * shell receives `ESC[<35;12;27M`-style reports as typed input and prints
 * them as text, which looks like garbled colour codes.
 *
 * Only input modes are reset here. Colours, cursor movement, Unicode, the
 * alternate screen and everything the replay drew stay as they are; the
 * new program turns on whatever it needs itself.
 */
export const RESET_INPUT_MODES = [
	"\x1b[?9l", // X10 mouse
	"\x1b[?1000l", // mouse button tracking
	"\x1b[?1001l", // highlight mouse tracking
	"\x1b[?1002l", // button-event (drag) tracking
	"\x1b[?1003l", // any-event (motion) tracking
	"\x1b[?1005l", // UTF-8 mouse encoding
	"\x1b[?1006l", // SGR mouse encoding
	"\x1b[?1015l", // urxvt mouse encoding
	"\x1b[?1004l", // focus in/out reporting
	"\x1b[?2004l", // bracketed paste
	"\x1b[?1l", // application cursor keys
	"\x1b>", // normal keypad
].join("");

interface Writable {
	write(data: string, callback?: () => void): void;
}

/** Switch off input reporting left over from replayed output. */
export function resetInputModes(terminal: Writable): void {
	terminal.write(RESET_INPUT_MODES);
}
