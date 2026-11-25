import { describe, expect, it } from "bun:test";
import { BUILT_IN_TEMPLATES } from "./specialist-templates";
import { findTeamPreset, planPreset, TEAM_PRESETS } from "./team-presets";

const templates = BUILT_IN_TEMPLATES.map((t) => ({ id: t.id, name: t.name }));

describe("team presets", () => {
	it("every preset names only built-in templates, without repeats", () => {
		const ids = new Set(templates.map((t) => t.id));
		for (const preset of TEAM_PRESETS) {
			expect(preset.templates.every((id) => ids.has(id))).toBe(true);
			expect(new Set(preset.templates).size).toBe(preset.templates.length);
		}
		// Full teams: a range of specialties for every kind of project.
		expect(findTeamPreset("web-app")?.templates).toEqual([
			"frontend",
			"ui",
			"ux",
			"backend",
			"api",
			"database",
			"qa",
			"security",
			"devops",
			"performance",
			"documentation",
			"research",
		]);
		for (const preset of TEAM_PRESETS) {
			expect(preset.templates.length).toBeGreaterThanOrEqual(5);
		}
		// Every preset brings a Research Agent.
		for (const preset of TEAM_PRESETS) {
			expect(preset.templates).toContain("research");
		}
		expect(findTeamPreset("game-dev")?.templates[0]).toBe("gamedev");
	});

	it("a new team gets an agent and a specialist per template", () => {
		const steps = planPreset(
			findTeamPreset("web-app") as NonNullable<
				ReturnType<typeof findTeamPreset>
			>,
			templates,
			[{ workspaceId: "main", name: "default" }],
			[],
		);
		expect(
			steps.map((s) => [s.agentName, s.agentWorkspaceId, s.specialist]),
		).toEqual([
			["Frontend Agent", undefined, "create"],
			["UI Agent", undefined, "create"],
			["UX Agent", undefined, "create"],
			["Backend Agent", undefined, "create"],
			["API Agent", undefined, "create"],
			["Database Agent", undefined, "create"],
			["QA and testing Agent", undefined, "create"],
			["Security Agent", undefined, "create"],
			["DevOps Agent", undefined, "create"],
			["Performance Agent", undefined, "create"],
			["Documentation Agent", undefined, "create"],
			["Research Agent", undefined, "create"],
		]);
	});

	it("applying again, or over a team's own setup, adds only what is missing", () => {
		const steps = planPreset(
			findTeamPreset("web-app") as NonNullable<
				ReturnType<typeof findTeamPreset>
			>,
			templates,
			[
				{ workspaceId: "fe", name: "frontend agent" },
				{ workspaceId: "be", name: "Backend Agent" },
			],
			[
				{ id: "s1", name: "Frontend", agentWorkspaceId: "fe" },
				{ id: "s2", name: "backend" },
			],
		);
		expect(
			steps.map((s) => [
				s.agentName,
				s.agentWorkspaceId,
				s.specialist,
				s.specialistId,
			]),
		).toEqual(
			expect.arrayContaining([
				["Frontend Agent", "fe", "keep", "s1"],
				["Backend Agent", "be", "assign", "s2"],
				["Research Agent", undefined, "create", undefined],
			]),
		);
		expect(steps.filter((s) => s.specialist === "create")).toHaveLength(10);
	});
});
