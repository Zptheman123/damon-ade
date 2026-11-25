import { resolve } from "node:path";
import type { TaskRoute } from "shared/utils/task-routing";
import type { TaskRecord, TaskState } from "./tasks";

/**
 * How long a team plan still takes, for the countdown in the team's top bar.
 *
 * Each subtask's time is the Coordinator's estimate (or a default by route),
 * scaled by the pace the finished subtasks actually took. Subtasks that wait
 * for others add up along the longest chain; subtasks in the same folder
 * run one after another. The agreed time box caps it.
 */

/** Minutes per route when the Coordinator gave no estimate. */
export const DEFAULT_ROUTE_MINUTES: Record<TaskRoute, number> = {
	quick: 10,
	implement: 25,
	plan: 45,
	exceptional: 60,
};
/** The Team chat's review of a finished subtask. */
const REVIEW_MINUTES = 3;

export interface PlanEta {
	requestSlug: string;
	title: string;
	state: TaskState;
	startedAt: string;
	/** When it is expected to finish (now, once it has). */
	finishAt: string;
	/** The time box agreed in the Team chat, if any. */
	deadline?: string;
	/** The estimate is the time box: the work would take longer. */
	cappedByDeadline: boolean;
	remainingMinutes: number;
	/** Actual time over estimated time, for the finished subtasks (1: on time). */
	pace: number;
	done: number;
	total: number;
	/** Titles of the subtasks running now. */
	running: string[];
}

const MINUTE = 60_000;

function minutesBetween(from: string | undefined, to: Date): number {
	if (!from) return 0;
	const start = Date.parse(from);
	return Number.isFinite(start)
		? Math.max(0, (to.getTime() - start) / MINUTE)
		: 0;
}

/** When the subtask started working, and when its last run ended. */
function span(task: TaskRecord): { start?: string; end?: string } {
	const runs = task.runs;
	return {
		start: runs[0]?.startedAt ?? runs[0]?.queuedAt,
		end: [...runs].reverse().find((r) => r.endedAt)?.endedAt,
	};
}

function estimateOf(task: TaskRecord): number {
	return task.estimateMinutes ?? DEFAULT_ROUTE_MINUTES[task.route] ?? 25;
}

function folderOf(task: TaskRecord): string {
	const path = resolve(task.identity.worktreePath).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? path.toLowerCase() : path;
}

export function planEta(
	request: TaskRecord,
	children: TaskRecord[],
	now: Date,
): PlanEta {
	const review = !!request.coordinator?.review;
	const approved = (c: TaskRecord) =>
		c.state === "cancelled" ||
		(c.state === "done" && (!review || c.review?.state === "approved"));
	const finished = request.state === "done" || request.state === "cancelled";

	// The pace so far: how long finished subtasks took against their estimate.
	let actual = 0;
	let estimated = 0;
	for (const child of children) {
		if (child.state !== "done") continue;
		const { start, end } = span(child);
		if (!start || !end) continue;
		actual += minutesBetween(start, new Date(end));
		estimated += estimateOf(child);
	}
	const pace =
		estimated > 0 ? Math.min(3, Math.max(0.5, actual / estimated)) : 1;

	const remainingOf = (child: TaskRecord): number => {
		if (approved(child)) return 0;
		if (child.state === "done") return REVIEW_MINUTES;
		const work = estimateOf(child) * pace;
		const after = review ? REVIEW_MINUTES : 0;
		if (child.state === "running") {
			const elapsed = minutesBetween(span(child).start, now);
			return Math.max(work - elapsed, work * 0.15) + after;
		}
		return work + after;
	};

	// The longest chain of subtasks that wait for one another...
	const bySlug = new Map(children.map((c) => [c.slug, c]));
	const memo = new Map<string, number>();
	const chain = (child: TaskRecord, seen: Set<string>): number => {
		const known = memo.get(child.slug);
		if (known !== undefined) return known;
		if (seen.has(child.slug)) return 0;
		seen.add(child.slug);
		let before = 0;
		for (const slug of child.dependsOn ?? []) {
			const dep = bySlug.get(slug);
			if (dep) before = Math.max(before, chain(dep, seen));
		}
		const total = before + remainingOf(child);
		memo.set(child.slug, total);
		return total;
	};
	let remaining = 0;
	for (const child of children) {
		remaining = Math.max(remaining, chain(child, new Set()));
	}
	// ...or the busiest folder, where subtasks run one at a time.
	const perFolder = new Map<string, number>();
	for (const child of children) {
		const key = folderOf(child);
		perFolder.set(key, (perFolder.get(key) ?? 0) + remainingOf(child));
	}
	for (const minutes of perFolder.values()) {
		remaining = Math.max(remaining, minutes);
	}
	if (finished) remaining = 0;

	let finishAt = new Date(now.getTime() + remaining * MINUTE);
	const deadline = request.coordinator?.deadline;
	let cappedByDeadline = false;
	if (deadline && !finished) {
		const limit = Date.parse(deadline);
		if (Number.isFinite(limit) && finishAt.getTime() > limit) {
			finishAt = new Date(Math.max(limit, now.getTime()));
			remaining = Math.max(0, (finishAt.getTime() - now.getTime()) / MINUTE);
			cappedByDeadline = true;
		}
	}

	const firstStart = children
		.map((c) => span(c).start)
		.filter((s): s is string => !!s)
		.sort()[0];
	return {
		requestSlug: request.slug,
		title: request.title,
		state: request.state,
		startedAt:
			request.coordinator?.startedAt ?? firstStart ?? request.createdAt,
		finishAt: finishAt.toISOString(),
		deadline,
		cappedByDeadline,
		remainingMinutes: Math.round(remaining * 10) / 10,
		pace: Math.round(pace * 100) / 100,
		done: children.filter((c) => c.state === "done").length,
		total: children.length,
		running: children.filter((c) => c.state === "running").map((c) => c.title),
	};
}
