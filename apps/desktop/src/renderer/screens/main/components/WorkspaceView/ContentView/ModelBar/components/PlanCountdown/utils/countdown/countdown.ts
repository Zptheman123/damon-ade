/** "1:05:09" (or "5:09" under an hour) for a time left in milliseconds. */
export function formatCountdown(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return hours > 0
		? `${hours}:${pad(minutes)}:${pad(seconds)}`
		: `${minutes}:${pad(seconds)}`;
}

/** How far along the plan is (0 to 1), from its start to its expected end. */
export function countdownProgress(
	startedAt: string,
	finishAt: string,
	now: number,
): number {
	const start = Date.parse(startedAt);
	const end = Date.parse(finishAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
		return now >= end ? 1 : 0;
	}
	return Math.min(1, Math.max(0, (now - start) / (end - start)));
}
