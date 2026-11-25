import { describe, expect, it } from "bun:test";
import { countdownProgress, formatCountdown } from "./countdown";

describe("countdown", () => {
	it("shows hours, minutes and seconds left", () => {
		expect(formatCountdown(3_909_000)).toBe("1:05:09");
		expect(formatCountdown(309_400)).toBe("5:09");
		expect(formatCountdown(-5)).toBe("0:00");
	});

	it("fills the bar from the start to the expected end", () => {
		const start = "2026-11-24T10:00:00.000Z";
		const end = "2026-11-24T14:00:00.000Z";
		expect(countdownProgress(start, end, Date.parse(start))).toBe(0);
		expect(
			countdownProgress(start, end, Date.parse("2026-11-24T11:00:00.000Z")),
		).toBe(0.25);
		expect(countdownProgress(start, end, Date.parse(end) + 1)).toBe(1);
	});
});
