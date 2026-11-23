import { cn } from "@superset/ui/utils";
import { useState } from "react";
import {
	LuChevronDown,
	LuChevronUp,
	LuCircleCheck,
	LuCircleDot,
	LuCircleX,
	LuPause,
} from "react-icons/lu";

export interface ActivityCurrent {
	title: string;
	kind: string;
	role: string | null;
	model: string | null;
	startedAt: string;
	costUsd: number;
	lastText: string | null;
	responses: number;
}

export interface ActivityItem {
	slug: string;
	title: string;
	state: string;
	reason: string | null;
	at?: string;
	costUsd?: number;
}

interface AgentActivityViewProps {
	current: ActivityCurrent | null;
	waiting: ActivityItem[];
	queued: number;
	recent: ActivityItem[];
	/** For elapsed time and "ago" (passed in so it is testable). */
	now: number;
	onOpenTasks: () => void;
}

const STEP: Record<string, string> = {
	quick: "Quick change",
	implement: "Implementing",
	plan: "Planning",
	build: "Building",
	fix: "Fixing",
	review: "Reviewing",
	escalate: "Architect",
	custom: "Specialist check",
	triage: "Choosing the approach",
	research: "Researching",
	split: "Splitting the request",
	checks: "Running checks",
	deps: "Auditing dependencies",
};

function shortModel(model: string | null): string {
	if (!model) return "";
	const m = model.match(/claude-([a-z]+)/i);
	return m ? m[1][0].toUpperCase() + m[1].slice(1) : model;
}

export function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ago(at: string | undefined, now: number): string {
	if (!at) return "";
	const ms = now - Date.parse(at);
	if (ms < 60_000) return "just now";
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
	return `${Math.round(ms / 86_400_000)} d ago`;
}

function StateIcon({ state }: { state: string }) {
	if (state === "done")
		return (
			<LuCircleCheck
				className="size-3.5 shrink-0 text-emerald-500"
				aria-hidden
			/>
		);
	if (state === "paused" || state === "needs-input")
		return <LuPause className="size-3.5 shrink-0 text-amber-500" aria-hidden />;
	if (state === "blocked" || state === "failed")
		return (
			<LuCircleX className="size-3.5 shrink-0 text-destructive" aria-hidden />
		);
	return (
		<LuCircleDot
			className="size-3.5 shrink-0 text-muted-foreground"
			aria-hidden
		/>
	);
}

/**
 * What this workspace's agent is doing, under the toolbar: working (task,
 * step, model, time, cost, its latest message), waiting for you, or idle
 * with what it did last. Details list recent work.
 */
export function AgentActivityView({
	current,
	waiting,
	queued,
	recent,
	now,
	onOpenTasks,
}: AgentActivityViewProps) {
	const [open, setOpen] = useState(false);
	if (!current && !waiting.length && !recent.length) return null;
	const last = recent[0];

	return (
		<div
			className="border-b bg-muted/20 px-3 py-1.5 text-xs"
			data-agent-activity
		>
			<div className="flex items-center gap-2">
				{current ? (
					<>
						<span className="relative flex size-2 shrink-0" aria-hidden>
							<span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
							<span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
						</span>
						<span className="shrink-0 font-medium">
							{STEP[current.kind] ?? current.kind}
						</span>
						<span className="min-w-0 truncate" title={current.title}>
							{current.title}
						</span>
						<span className="shrink-0 text-muted-foreground">
							{[
								current.role,
								shortModel(current.model),
								duration(now - Date.parse(current.startedAt)),
								current.costUsd ? `$${current.costUsd.toFixed(2)}` : "",
							]
								.filter(Boolean)
								.join(" · ")}
						</span>
					</>
				) : waiting.length ? (
					<>
						<LuPause className="size-3.5 shrink-0 text-amber-500" aria-hidden />
						<span className="shrink-0 font-medium text-amber-700 dark:text-amber-400">
							Waiting for you
						</span>
						<span
							className="min-w-0 truncate"
							title={waiting[0].reason ?? undefined}
						>
							{waiting[0].title}
							{waiting[0].reason ? ` — ${waiting[0].reason}` : ""}
						</span>
					</>
				) : (
					<>
						<span
							className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
							aria-hidden
						/>
						<span className="shrink-0 font-medium text-muted-foreground">
							Idle
						</span>
						{last && (
							<span
								className="min-w-0 truncate text-muted-foreground"
								title={last.reason ?? undefined}
							>
								Last: {last.title} —{" "}
								{last.state === "done" ? "finished" : last.state}{" "}
								{ago(last.at, now)}
							</span>
						)}
					</>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-1">
					{queued > 0 && (
						<span className="text-muted-foreground">{queued} queued</span>
					)}
					{waiting.length > 0 && (
						<button
							type="button"
							onClick={onOpenTasks}
							className="rounded px-1.5 py-0.5 font-medium text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
						>
							Open Tasks
						</button>
					)}
					<button
						type="button"
						onClick={() => setOpen((v) => !v)}
						className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
						aria-expanded={open}
					>
						{open ? (
							<LuChevronUp className="size-3" aria-hidden />
						) : (
							<LuChevronDown className="size-3" aria-hidden />
						)}
						History
					</button>
				</span>
			</div>
			{current?.lastText && (
				<p
					className="mt-0.5 truncate pl-4 text-muted-foreground italic"
					title={current.lastText}
					data-agent-last-text
				>
					“{current.lastText.replace(/\s+/g, " ").trim()}”
				</p>
			)}
			{open && (
				<ul className="mt-1.5 space-y-1 pl-1" data-agent-history>
					{[
						...waiting,
						...recent.filter((r) => !waiting.some((w) => w.slug === r.slug)),
					].map((item) => (
						<li key={item.slug} className="flex items-start gap-1.5">
							<StateIcon state={item.state} />
							<span className="min-w-0 flex-1">
								<span className="font-medium">{item.title}</span>
								{item.reason && (
									<span
										className="block truncate text-muted-foreground"
										title={item.reason}
									>
										{item.reason}
									</span>
								)}
							</span>
							<span
								className={cn("shrink-0 text-muted-foreground tabular-nums")}
							>
								{[
									item.costUsd ? `$${item.costUsd.toFixed(2)}` : "",
									ago(item.at, now),
								]
									.filter(Boolean)
									.join(" · ")}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
