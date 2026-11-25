import { describe, expect, it } from "bun:test";
import { planWindowView, usd } from "./planWindow";

const now = Date.parse("2026-11-24T12:00:00.000Z");

describe("planWindowView", () => {
	it("shows the use and when it resets", () => {
		expect(
			planWindowView(
				{
					percent: 42,
					resetsAt: "2026-11-24T14:05:00.000Z",
					status: "allowed",
				},
				now,
			),
		).toEqual({ percent: 42, resetsIn: "in 2 h 5 min", level: "ok" });
	});

	it("warns near the limit and when Claude refuses", () => {
		expect(planWindowView({ percent: 80 }, now).level).toBe("warn");
		expect(planWindowView({ status: "allowed_warning" }, now).level).toBe(
			"warn",
		);
		expect(planWindowView({ percent: 30, status: "rejected" }, now).level).toBe(
			"full",
		);
	});

	it("starts from nothing once the window has reset", () => {
		expect(
			planWindowView(
				{ percent: 95, resetsAt: "2026-11-24T11:00:00.000Z" },
				now,
			),
		).toEqual({ percent: 0, level: "ok" });
	});

	it("formats dollars", () => {
		expect(usd(3.456)).toBe("$3.46");
		expect(usd(1234.5)).toBe("$1235");
	});
});
