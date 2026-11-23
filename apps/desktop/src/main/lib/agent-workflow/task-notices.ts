import type { TaskRecord } from "./tasks";

/**
 * Telling the user when work stops or finishes, so nothing waits silently.
 * One notice per change of a top-level task or team request (subtasks are
 * reported through their request), and none for stops ADE resumes by
 * itself or that the user asked for.
 */

export interface TaskNotice {
	title: string;
	body: string;
	projectKey: string;
	slug: string;
}

/** Stops that need no one: ADE continues, or the user paused it. */
const SELF_RESOLVING =
	/tries again in|continues on its own|starts by itself|^Paused\.$|^Pausing after|^Resuming\.$|^Starting\.$/i;

export function noticeFor(
	previous: string | undefined,
	task: Pick<
		TaskRecord,
		"state" | "stateReason" | "title" | "parentSlug" | "isRequest" | "slug"
	>,
	projectKey: string,
): TaskNotice | undefined {
	if (task.parentSlug) return undefined;
	if (previous === undefined || previous === task.state) return undefined;
	const reason = (task.stateReason ?? "").trim();
	const what = task.isRequest ? "Team request" : "Task";
	const name =
		task.title.length > 70 ? `${task.title.slice(0, 67)}…` : task.title;
	const notice = (title: string, body: string): TaskNotice => ({
		title,
		body: body.slice(0, 240),
		projectKey,
		slug: task.slug,
	});
	switch (task.state) {
		case "done":
			return notice(`${what} finished`, `${name}: ${reason || "done"}`);
		case "needs-input":
			return notice(`${what} needs your answer`, `${name}: ${reason}`);
		case "blocked":
		case "failed":
			return notice(`${what} stopped`, `${name}: ${reason}`);
		case "paused":
			if (!reason || SELF_RESOLVING.test(reason)) return undefined;
			return notice(`${what} is waiting for you`, `${name}: ${reason}`);
		default:
			return undefined;
	}
}

/**
 * Remembers each task's last state and returns a notice for a change worth
 * telling. The first look at a task only records it (no flood at start).
 */
export function createTaskNotifier(notify: (notice: TaskNotice) => void) {
	const seen = new Map<string, string>();
	const key = (projectKey: string, slug: string) => `${projectKey}::${slug}`;
	return {
		/** Record a state without telling (at start-up). */
		seed(projectKey: string, task: Pick<TaskRecord, "slug" | "state">) {
			seen.set(key(projectKey, task.slug), task.state);
		},
		changed(projectKey: string, task: TaskRecord) {
			const k = key(projectKey, task.slug);
			const previous = seen.get(k);
			seen.set(k, task.state);
			const notice = noticeFor(previous, task, projectKey);
			if (notice) notify(notice);
		},
	};
}
