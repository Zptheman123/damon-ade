import { describe, expect, it } from "bun:test";
import { planEta } from "./plan-eta";
import type { TaskRecord, TaskRun } from "./tasks";

const T0 = Date.parse("2026-11-24T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function run(start: number, end?: number): TaskRun {
	return {
		id: `r${start}`,
		kind: "quick",
		status: end === undefined ? "running" : "succeeded",
		attempt: 1,
		queuedAt: at(start),
		startedAt: at(start),
		endedAt: end === undefined ? undefined : at(end),
	} as TaskRun;
}

function task(
	slug: string,
	over: Partial<TaskRecord> & { folder?: string } = {},
): TaskRecord {
	const { folder, ...rest } = over;
	return {
		version: 2,
		slug,
		title: slug,
		description: slug,
		route: "implement",
		routeReasons: [],
		createdAt: at(0),
		mode: "auto",
		state: "idle",
		identity: {
			workspaceId: "ws",
			worktreePath: folder ?? `/work/${slug}`,
			baselineDirty: {},
		},
		limits: {
			budgetUsd: 5,
			maxCorrections: 2,
			maxReviewRounds: 2,
			maxEscalations: 1,
		},
		runs: [],
		...rest,
	} as TaskRecord;
}

const request = (over: Partial<TaskRecord> = {}) =>
	task("plan", {
		isRequest: true,
		state: "running",
		coordinator: { review: false, startedAt: at(0) },
		...over,
	});

describe("planEta", () => {
	it("adds up the longest chain of subtasks that wait for each other", () => {
		const a = task("a", { estimateMinutes: 30 });
		const b = task("b", { estimateMinutes: 20, dependsOn: ["a"] });
		const c = task("c", { estimateMinutes: 15 });
		const eta = planEta(request(), [a, b, c], new Date(T0));
		expect(eta.remainingMinutes).toBe(50);
		expect(eta.finishAt).toBe(at(50));
		expect(eta.total).toBe(3);
	});

	it("runs subtasks in one folder one after another", () => {
		const a = task("a", { estimateMinutes: 30, folder: "/team" });
		const b = task("b", { estimateMinutes: 20, folder: "/team" });
		expect(planEta(request(), [a, b], new Date(T0)).remainingMinutes).toBe(50);
	});

	it("learns the pace from finished subtasks and counts down what is running", () => {
		// Took 40 minutes against an estimate of 20: twice as slow.
		const a = task("a", {
			estimateMinutes: 20,
			state: "done",
			runs: [run(0, 40)],
		});
		const b = task("b", {
			estimateMinutes: 10,
			state: "running",
			dependsOn: ["a"],
			runs: [run(40)],
		});
		const eta = planEta(request(), [a, b], new Date(T0 + 45 * 60_000));
		expect(eta.pace).toBe(2);
		// 10 minutes at twice the estimate, 5 of them gone.
		expect(eta.remainingMinutes).toBe(15);
		expect(eta.running).toEqual(["b"]);
	});

	it("waits for the Team chat's reviews and never passes the time box", () => {
		const reviewed = request({
			coordinator: { review: true, startedAt: at(0), deadline: at(60) },
		});
		const a = task("a", { state: "done", runs: [run(0, 25)] });
		const b = task("b", { estimateMinutes: 25, dependsOn: ["a"] });
		const soon = planEta(reviewed, [a, b], new Date(T0 + 25 * 60_000));
		// a: its review (3); b: 25 at a pace of 1, then its review (3).
		expect(soon.remainingMinutes).toBe(31);
		expect(soon.cappedByDeadline).toBe(false);

		const slow = task("b", { estimateMinutes: 200, dependsOn: ["a"] });
		const capped = planEta(reviewed, [a, slow], new Date(T0 + 25 * 60_000));
		expect(capped.finishAt).toBe(at(60));
		expect(capped.cappedByDeadline).toBe(true);
	});

	it("has nothing left once the plan is done", () => {
		const a = task("a", { state: "done", runs: [run(0, 10)] });
		const eta = planEta(request({ state: "done" }), [a], new Date(T0));
		expect(eta.remainingMinutes).toBe(0);
		expect(eta.done).toBe(1);
	});
});
