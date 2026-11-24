import { describe, expect, it } from "bun:test";
import { terminalQr } from "./terminalQr";

const row = (s: string) => `  ${s}`;
const QR = Array.from({ length: 12 }, (_, i) =>
	row(i % 2 ? "█▀▀▀▀▀█ ▄▀▄ █▀▀▀▀▀█" : "█ ███ █ ▀▄▀ █ ███ █"),
);

describe("terminalQr", () => {
	it("finds the QR code Expo printed, without its indent or colors", () => {
		const lines = [
			"Starting Metro Bundler",
			...QR.map((l, i) => (i === 0 ? `\u001b[1m${l}\u001b[22m` : l)),
			"› Metro waiting on exp://192.168.1.20:8081",
		];
		const qr = terminalQr(lines);
		expect(qr).toHaveLength(12);
		expect(qr?.[0].startsWith("█")).toBe(true);
	});

	it("keeps the latest one when the server printed it again", () => {
		const second = QR.map((l) => l.replace("▄▀▄", "▀▀▀"));
		const qr = terminalQr([...QR, "Reloading", ...second]);
		expect(qr?.[1]).toContain("▀▀▀");
	});

	it("ignores ordinary output and short block-character lines", () => {
		expect(terminalQr(["hello", "████", "▀▀▀ done"])).toBeUndefined();
	});
});
