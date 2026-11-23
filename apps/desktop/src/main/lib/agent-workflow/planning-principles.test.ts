import { describe, expect, it } from "bun:test";
import { PLANNING_PRINCIPLES, stagePrompt } from "./stage-prompts";
import type { TaskRecord } from "./tasks";

const task = {
	slug: "calendar",
	title: "Build a calendar",
	description: "Build a desktop calendar app with a nice UI",
	route: "plan",
	runs: [],
} as unknown as TaskRecord;

const input = (extra: Partial<TaskRecord> = {}) => ({
	stage: "split" as const,
	task: { ...task, ...extra },
	tasksDir: "/ade/tasks",
	checks: [],
	mayRunChecks: false,
	triage: {
		specialists: [
			{ name: "Frontend", specialty: "Web UI", agent: "Frontend Agent" },
		],
		remainingUsd: 10,
	},
});

describe("how the Coordinator splits work", () => {
	it("by whole features, few subtasks, quality in the description", () => {
		expect(PLANNING_PRINCIPLES).toContain(
			"Split by feature, not by layer or specialty",
		);
		expect(PLANNING_PRINCIPLES).toContain(
			"Never make separate subtasks for a design system",
		);
		expect(PLANNING_PRINCIPLES).toContain("Prefer 1 to 3 subtasks");
		expect(PLANNING_PRINCIPLES).toContain("the quality bar");
	});

	it("reaches both the one-shot split and the team chat", () => {
		expect(stagePrompt(input())).toContain(PLANNING_PRINCIPLES);
		const chat = stagePrompt(
			input({
				chat: [
					{
						role: "user",
						text: "Build me a calendar",
						at: "2026-11-22T00:00:00Z",
					},
				],
			} as Partial<TaskRecord>),
		);
		expect(chat).toContain(PLANNING_PRINCIPLES);
	});
});
