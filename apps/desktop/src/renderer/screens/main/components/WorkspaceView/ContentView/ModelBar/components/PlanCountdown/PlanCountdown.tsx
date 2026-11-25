import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useEffect, useState } from "react";
import { LuTimer } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { countdownProgress, formatCountdown } from "./utils/countdown";

const clock = (iso: string) =>
	new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * The countdown for the plan the Team chat is running: a bar that fills
 * from the plan's start to its expected end, and the time left, ticking
 * every second. The expected end is re-estimated as subtasks finish (their
 * real pace, what is left, what waits for what) and never passes the time
 * box agreed in the Team chat.
 */
export function PlanCountdown({ workspaceId }: { workspaceId: string }) {
	const { data: eta } = electronTrpc.workflow.getPlanCountdown.useQuery(
		{ workspaceId },
		{ refetchInterval: 20_000 },
	);
	const utils = electronTrpc.useUtils();
	electronTrpc.workflow.onTaskChanged.useSubscription(undefined, {
		onData: () =>
			void utils.workflow.getPlanCountdown.invalidate({ workspaceId }),
	});
	const [now, setNow] = useState(() => Date.now());
	const ticking = !!eta && eta.state !== "done";
	useEffect(() => {
		if (!ticking) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [ticking]);

	if (!eta) return null;
	const done = eta.state === "done";
	const stopped = !done && eta.state !== "running";
	const left = Date.parse(eta.finishAt) - now;
	const progress = done
		? 1
		: countdownProgress(eta.startedAt, eta.finishAt, now);
	const label = done
		? "Done"
		: stopped
			? "Paused"
			: left <= 0
				? "Almost done"
				: formatCountdown(left);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div
					className="mx-1 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs tabular-nums text-muted-foreground"
					role="timer"
					aria-label={`Team plan: ${label}${done || stopped ? "" : " left"}`}
					data-plan-countdown={eta.state}
				>
					<LuTimer className="size-3.5 shrink-0" aria-hidden />
					<div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-muted">
						<div
							className={cn(
								"absolute inset-y-0 left-0 rounded-full transition-[width] duration-1000 ease-linear",
								done
									? "bg-emerald-500"
									: stopped
										? "bg-amber-500"
										: "bg-primary",
							)}
							style={{ width: `${Math.round(progress * 1000) / 10}%` }}
						/>
					</div>
					<span
						className={cn(
							"min-w-[3.25rem] text-right font-medium",
							done && "text-emerald-700 dark:text-emerald-400",
							stopped && "text-amber-700 dark:text-amber-400",
							!done && !stopped && "text-foreground",
						)}
					>
						{label}
					</span>
				</div>
			</TooltipTrigger>
			<TooltipContent side="bottom" showArrow={false} className="max-w-72">
				<div className="space-y-1 text-xs">
					<p className="font-medium">{eta.title}</p>
					<p>
						{eta.done} of {eta.total} subtasks done
						{eta.running.length ? ` · running: ${eta.running.join(", ")}` : ""}
					</p>
					{!done && (
						<p>
							Expected to finish around {clock(eta.finishAt)}
							{eta.cappedByDeadline
								? " (the time box: the rest would take longer)"
								: ""}
							.
						</p>
					)}
					{eta.deadline && !done && (
						<p>
							Time box agreed in the Team chat ends at {clock(eta.deadline)}.
						</p>
					)}
					{eta.pace !== 1 && (
						<p className="text-muted-foreground">
							So far the agents take {eta.pace}× their estimates; the countdown
							allows for it.
						</p>
					)}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
