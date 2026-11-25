import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadPlanLimits,
	parseRateLimitInfo,
	recordPlanLimits,
} from "./plan-limits";

const home = mkdtempSync(join(tmpdir(), "ade-plan-limits-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("plan limits", () => {
	it("reads both windows from a rate_limit_event", () => {
		const parsed = parseRateLimitInfo({
			status: "allowed",
			unifiedWindows: {
				five_hour: { utilization: 0.42, resetsAt: 1_795_000_000 },
				seven_day: { utilization: 0.18, resetsAt: 1_795_500_000 },
			},
		});
		expect(parsed?.fiveHour).toEqual({
			percent: 42,
			resetsAt: new Date(1_795_000_000_000).toISOString(),
			status: undefined,
		});
		expect(parsed?.weekly?.percent).toBe(18);
		expect(parsed?.status).toBe("allowed");
	});

	it("reads the window an event names, and ignores what is not one", () => {
		const parsed = parseRateLimitInfo({
			status: "allowed_warning",
			rateLimitType: "seven_day_opus",
			utilization: 0.9,
		});
		expect(parsed?.weekly).toEqual({
			percent: 90,
			resetsAt: undefined,
			status: "allowed_warning",
		});
		expect(parsed?.fiveHour).toBeUndefined();
		expect(parseRateLimitInfo("nope")).toBeUndefined();
		expect(parseRateLimitInfo({})).toBeUndefined();
	});

	it("keeps the latest of each window across runs", () => {
		const now = new Date("2026-11-24T12:00:00.000Z");
		recordPlanLimits(
			home,
			{ unifiedWindows: { five_hour: { utilization: 0.3 } } },
			now,
		);
		recordPlanLimits(
			home,
			{ rateLimitType: "seven_day", utilization: 0.5 },
			new Date(now.getTime() + 60_000),
		);
		const saved = loadPlanLimits(home);
		expect(saved?.fiveHour?.percent).toBe(30);
		expect(saved?.weekly?.percent).toBe(50);
		expect(saved?.updatedAt).toBe("2026-11-24T12:01:00.000Z");
	});
});
