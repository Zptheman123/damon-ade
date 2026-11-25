import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { cn } from "@superset/ui/utils";
import { useState } from "react";
import { LuGauge } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { type PlanWindowView, planWindowView, usd } from "./utils/planWindow";

const LEVEL_BAR = {
	ok: "bg-primary",
	warn: "bg-amber-500",
	full: "bg-red-500",
} as const;

function Meter({ label, view }: { label: string; view: PlanWindowView }) {
	return (
		<div className="space-y-1">
			<div className="flex justify-between gap-3 text-xs">
				<span>{label}</span>
				<span className="tabular-nums text-muted-foreground">
					{view.percent === undefined
						? "not reported yet"
						: `${view.percent}% used`}
					{view.resetsIn ? ` · resets ${view.resetsIn}` : ""}
				</span>
			</div>
			<div className="h-1.5 overflow-hidden rounded-full bg-muted">
				<div
					className={cn("h-full rounded-full", LEVEL_BAR[view.level])}
					style={{ width: `${view.percent ?? 0}%` }}
				/>
			</div>
		</div>
	);
}

/**
 * Usage across every team: how much of the Claude plan's 5-hour and weekly
 * allowance is used (as the latest agent run reported it), and what all
 * recorded work would cost at API prices.
 */
export function UsageMeter() {
	const [open, setOpen] = useState(false);
	const { data } = electronTrpc.workflow.getGlobalUsage.useQuery(undefined, {
		refetchInterval: open ? 15_000 : 60_000,
	});
	if (!data) return null;
	const now = Date.now();
	const fiveHour = planWindowView(data.limits?.fiveHour, now);
	const weekly = planWindowView(data.limits?.weekly, now);
	const known = fiveHour.percent !== undefined || weekly.percent !== undefined;
	const worst =
		fiveHour.level === "full" || weekly.level === "full"
			? "full"
			: fiveHour.level === "warn" || weekly.level === "warn"
				? "warn"
				: "ok";

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex h-7 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums transition-colors hover:bg-muted hover:text-foreground",
						worst === "full"
							? "text-red-600 dark:text-red-400"
							: worst === "warn"
								? "text-amber-700 dark:text-amber-400"
								: "text-muted-foreground",
					)}
					title="Usage across all teams"
					data-usage-meter={worst}
				>
					<LuGauge className="size-3.5" aria-hidden />
					{known ? (
						<span>
							5h {fiveHour.percent ?? "–"}% · wk {weekly.percent ?? "–"}%
						</span>
					) : (
						<span>{usd(data.todayUsd)} today</span>
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 space-y-3 p-3">
				<div>
					<p className="text-sm font-medium">Usage, all teams</p>
					<p className="text-xs text-muted-foreground">
						{data.limits
							? `Your Claude plan, as of ${new Date(data.limits.updatedAt).toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })} (each agent run updates it).`
							: "Your Claude plan's limits show here after the next agent run."}
					</p>
				</div>
				<Meter label="5-hour limit" view={fiveHour} />
				<Meter label="Weekly limit" view={weekly} />
				<div className="space-y-1 border-t pt-2 text-xs">
					<p className="font-medium">At API prices</p>
					<div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
						<span className="text-muted-foreground">Last 5 hours</span>
						<span className="text-right">{usd(data.last5hUsd)}</span>
						<span className="text-muted-foreground">Today</span>
						<span className="text-right">{usd(data.todayUsd)}</span>
						<span className="text-muted-foreground">Last 7 days</span>
						<span className="text-right">{usd(data.weekUsd)}</span>
						<span className="text-muted-foreground">All time</span>
						<span className="text-right">{usd(data.allTimeUsd)}</span>
					</div>
					<p className="text-muted-foreground">
						Estimates of what the same work would cost on the API; on a
						subscription they are not charges.
						{data.unpriced ? " Some responses had no known price." : ""}
					</p>
				</div>
			</PopoverContent>
		</Popover>
	);
}
