import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Claude plan's usage limits, as Claude Code reports them during runs
 * (stream-json "rate_limit_event"): how much of the 5-hour and the weekly
 * allowance is used, and when each resets. Kept in one small file so the
 * usage meter shows the latest known values across ADE restarts.
 */

export interface PlanWindow {
	/** Percent of the window used (0 to 100), when Claude reported it. */
	percent?: number;
	resetsAt?: string;
	/** "allowed", "allowed_warning" or "rejected". */
	status?: string;
}

export interface PlanLimits {
	updatedAt: string;
	fiveHour?: PlanWindow;
	weekly?: PlanWindow;
	/** The overall state: "allowed", "allowed_warning" or "rejected". */
	status?: string;
}

function percentOf(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	// Reported as a fraction (0.42); a value over 1 is already a percent.
	const percent = value <= 1 ? value * 100 : value;
	return Math.min(100, Math.round(percent * 10) / 10);
}

function timeOf(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		// Seconds since 1970 (milliseconds when it is that large).
		return new Date(value < 1e12 ? value * 1000 : value).toISOString();
	}
	if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
		return new Date(value).toISOString();
	}
	return undefined;
}

function windowOf(value: unknown): PlanWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const window: PlanWindow = {
		percent: percentOf(raw.utilization),
		resetsAt: timeOf(raw.resetsAt ?? raw.resets_at),
		status: typeof raw.status === "string" ? raw.status : undefined,
	};
	return window.percent !== undefined || window.resetsAt ? window : undefined;
}

/** What one rate_limit_event says about the plan's windows. */
export function parseRateLimitInfo(
	info: unknown,
): Omit<PlanLimits, "updatedAt"> | undefined {
	if (!info || typeof info !== "object") return undefined;
	const raw = info as Record<string, unknown>;
	const result: Omit<PlanLimits, "updatedAt"> = {
		status: typeof raw.status === "string" ? raw.status : undefined,
	};
	const unified = (raw.unifiedWindows ?? raw.unified_windows) as
		| Record<string, unknown>
		| undefined;
	if (unified && typeof unified === "object") {
		result.fiveHour = windowOf(unified.five_hour);
		result.weekly = windowOf(unified.seven_day);
	}
	// The window this event is about, when it names one.
	const type = String(raw.rateLimitType ?? raw.rate_limit_type ?? "");
	const own = windowOf({
		utilization: raw.utilization,
		resetsAt: raw.resetsAt ?? raw.resets_at,
		status: raw.status,
	});
	if (own && type === "five_hour" && !result.fiveHour) result.fiveHour = own;
	if (own && type.startsWith("seven_day") && !result.weekly)
		result.weekly = own;
	return result.fiveHour || result.weekly || result.status ? result : undefined;
}

function limitsPath(homeDir: string): string {
	return join(homeDir, "usage", "plan-limits.json");
}

export function loadPlanLimits(homeDir: string): PlanLimits | null {
	try {
		const data = JSON.parse(readFileSync(limitsPath(homeDir), "utf8"));
		return data && typeof data.updatedAt === "string" ? data : null;
	} catch {
		return null;
	}
}

/** Merge what a run just reported into the saved limits. */
export function recordPlanLimits(
	homeDir: string,
	info: unknown,
	now: Date,
): PlanLimits | null {
	const parsed = parseRateLimitInfo(info);
	if (!parsed) return null;
	const previous = loadPlanLimits(homeDir);
	const next: PlanLimits = {
		updatedAt: now.toISOString(),
		status: parsed.status ?? previous?.status,
		fiveHour: parsed.fiveHour ?? previous?.fiveHour,
		weekly: parsed.weekly ?? previous?.weekly,
	};
	const path = limitsPath(homeDir);
	mkdirSync(join(homeDir, "usage"), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
	return next;
}
