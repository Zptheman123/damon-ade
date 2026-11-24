// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
/** A row of a QR code drawn with block characters (Expo, qrcode-terminal). */
const QR_ROW = /^[\s█▀▄▌▐]+$/;
const MIN_WIDTH = 15;
const MIN_ROWS = 8;

/**
 * The last QR code a dev server drew in its output (Expo prints one for
 * Expo Go), as its rows, so it can be shown and scanned from ADE. Nothing
 * is generated: it is the code the server printed, or nothing.
 */
export function terminalQr(lines: string[]): string[] | undefined {
	let best: string[] | undefined;
	let run: string[] = [];
	const flush = () => {
		if (run.length >= MIN_ROWS) best = run;
		run = [];
	};
	for (const raw of lines) {
		const line = raw.replace(ANSI, "").replace(/\s+$/, "");
		if (QR_ROW.test(line) && line.trim().length >= MIN_WIDTH) {
			run.push(line);
		} else {
			flush();
		}
	}
	flush();
	if (!best) return undefined;
	// Drop the indent the rows share, keep their alignment.
	const indent = Math.min(
		...best.map((l) => l.length - l.replace(/^\s+/, "").length),
	);
	return best.map((l) => l.slice(indent));
}
