export interface PlanWindowInput {
	percent?: number;
	resetsAt?: string;
	status?: string;
}

export interface PlanWindowView {
	/** Percent used, or undefined when unknown. 0 once the window has reset. */
	percent?: number;
	/** "in 2 h 5 min", or undefined. */
	resetsIn?: string;
	level: "ok" | "warn" | "full";
}

function duration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		const rest = minutes % 60;
		return rest ? `${hours} h ${rest} min` : `${hours} h`;
	}
	return `${Math.round(hours / 24)} days`;
}

/** One plan window (5-hour or weekly) as the meter shows it now. */
export function planWindowView(
	window: PlanWindowInput | undefined,
	now: number,
): PlanWindowView {
	if (!window) return { level: "ok" };
	const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
	// Reported before the window reset: it starts again from nothing.
	if (Number.isFinite(reset) && reset <= now)
		return { percent: 0, level: "ok" };
	const percent = window.percent;
	const level =
		window.status === "rejected" || (percent ?? 0) >= 100
			? "full"
			: window.status === "allowed_warning" || (percent ?? 0) >= 75
				? "warn"
				: "ok";
	return {
		percent,
		resetsIn: Number.isFinite(reset)
			? `in ${duration(reset - now)}`
			: undefined,
		level,
	};
}

export function usd(value: number): string {
	return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}
