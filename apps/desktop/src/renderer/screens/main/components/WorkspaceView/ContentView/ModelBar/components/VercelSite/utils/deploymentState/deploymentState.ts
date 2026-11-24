/** How a Vercel deployment's state reads and looks in ADE. */
export function deploymentState(state: string): {
	label: string;
	dot: string;
} {
	switch (state) {
		case "READY":
			return { label: "Live", dot: "bg-emerald-500" };
		case "ERROR":
			return { label: "Failed", dot: "bg-red-500" };
		case "BUILDING":
		case "INITIALIZING":
			return { label: "Building", dot: "bg-amber-500 animate-pulse" };
		case "QUEUED":
			return { label: "Queued", dot: "bg-amber-500" };
		case "CANCELED":
			return { label: "Canceled", dot: "bg-muted-foreground/40" };
		default:
			return { label: state.toLowerCase(), dot: "bg-muted-foreground/40" };
	}
}

/** "3 min ago". */
export function timeAgo(ms: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} days ago`;
}
