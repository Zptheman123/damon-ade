import { describe, expect, it } from "bun:test";
import { createTaskNotifier, noticeFor, type TaskNotice } from "./task-notices";
import type { TaskRecord } from "./tasks";

const task = (over: Partial<TaskRecord>) =>
	({
		slug: "calendar",
		title: "Build a desktop calendar app",
		state: "running",
		...over,
	}) as TaskRecord;

describe("telling the user when work stops", () => {
	it("stops, questions and finishes are told; self-resuming pauses are not", () => {
		expect(
			noticeFor(
				"running",
				task({
					state: "blocked",
					stateReason: "Checks still fail after 2 correction(s).",
				}),
				"p",
			),
		).toMatchObject({
			title: "Task stopped",
			body: expect.stringContaining("Checks still fail"),
		});
		expect(
			noticeFor(
				"running",
				task({
					state: "needs-input",
					stateReason: "The plan needs your decision",
				}),
				"p",
			)?.title,
		).toBe("Task needs your answer");
		expect(
			noticeFor(
				"running",
				task({ state: "done", stateReason: "Verified." }),
				"p",
			)?.title,
		).toBe("Task finished");
		expect(
			noticeFor(
				"running",
				task({
					state: "paused",
					stateReason: "Waiting for your approval: npm install",
				}),
				"p",
			)?.title,
		).toBe("Task is waiting for you");
		for (const reason of [
			"Rate limited. ADE tries again in 5 minutes.",
			"ADE stopped while a run was in progress; it continues on its own in a moment.",
			"Paused.",
		]) {
			expect(
				noticeFor(
					"running",
					task({ state: "paused", stateReason: reason }),
					"p",
				),
			).toBeUndefined();
		}
	});

	it("a team request speaks for its subtasks", () => {
		expect(
			noticeFor("running", task({ state: "blocked", parentSlug: "req" }), "p"),
		).toBeUndefined();
		expect(
			noticeFor(
				"running",
				task({
					state: "paused",
					isRequest: true,
					stateReason: 'Subtask "Shell" stopped',
				}),
				"p",
			)?.title,
		).toBe("Team request is waiting for you");
	});

	it("only changes are told: nothing at start-up, nothing twice", () => {
		const told: TaskNotice[] = [];
		const notifier = createTaskNotifier((n) => told.push(n));
		notifier.seed("p", task({ state: "blocked" }));
		notifier.changed("p", task({ state: "blocked", stateReason: "x" }));
		expect(told).toEqual([]);
		notifier.changed("p", task({ state: "running" }));
		notifier.changed("p", task({ state: "done", stateReason: "Verified." }));
		notifier.changed("p", task({ state: "done", stateReason: "Verified." }));
		expect(told.map((n) => n.title)).toEqual(["Task finished"]);
	});
});
