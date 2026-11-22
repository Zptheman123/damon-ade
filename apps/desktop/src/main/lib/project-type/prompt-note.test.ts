import { describe, expect, it } from "bun:test";
import { projectPromptNote } from "./prompt-note";

describe("what agents are told about the project", () => {
	it("nothing when the team has no type or targets", () => {
		expect(projectPromptNote({ targets: [] })).toBe("");
	});

	it("the type, framework and how it runs, localhost only", () => {
		const note = projectPromptNote({
			type: "backend-api",
			framework: "Express",
			targets: [
				{
					id: "api",
					name: "API",
					kind: "service",
					cwd: "server",
					command: "bun run dev",
					url: "http://localhost:4000",
				},
			],
		});
		expect(note).toContain("Type: Backend / API service (Express).");
		expect(note).toContain(
			"- API: `bun run dev` in server (http://localhost:4000)",
		);
		expect(note).toContain("localhost only");
		expect(note).toContain("stop it before you finish");
	});
});
