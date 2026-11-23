import { describe, expect, it } from "bun:test";
import { FINISH_BAR, REVIEW_BAR, stagePrompt } from "./stage-prompts";
import { silentExit } from "./stage-runner";
import type { TaskRecord } from "./tasks";

const task = {
	slug: "calendar",
	title: "Month view",
	description: "A month view with events",
	route: "implement",
	runs: [],
} as unknown as TaskRecord;

const prompt = (stage: "implement" | "build" | "review" | "quick") =>
	stagePrompt({
		stage,
		task,
		tasksDir: "/ade/tasks",
		checks: ["npm run build"],
		mayRunChecks: true,
		changes: { tracked: true, files: ["src/month.tsx"], preexisting: [] },
	} as Parameters<typeof stagePrompt>[0]);

describe("the bar for finished work", () => {
	it("implementing runs finish it like a product and make sure it builds", () => {
		for (const stage of ["implement", "build"] as const) {
			expect(prompt(stage)).toContain(FINISH_BAR);
		}
		expect(FINISH_BAR).toContain("no placeholders");
		expect(FINISH_BAR).toContain("empty, loading and error states");
		expect(FINISH_BAR).toContain("make sure it builds and runs");
		// Small fully specified changes stay small.
		expect(prompt("quick")).not.toContain(FINISH_BAR);
	});

	it("reviews fail broken basics, not taste", () => {
		expect(prompt("review")).toContain(REVIEW_BAR);
		expect(REVIEW_BAR).toContain("controls that do nothing");
		expect(REVIEW_BAR).toContain("Do not fail work for matters of taste");
	});
});

describe("a run that stops without saying why", () => {
	it("says how far it got and what it last said, not a bare exit code", () => {
		const message = silentExit(
			1,
			12,
			"Now wiring the\n  month grid to the store.",
		);
		expect(message).toContain("exit 1");
		expect(message).toContain("after 12 response(s)");
		expect(message).toContain('"Now wiring the month grid to the store."');
		expect(silentExit(1, 0, undefined)).toContain("before saying anything");
	});
});
