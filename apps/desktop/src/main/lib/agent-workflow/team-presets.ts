/**
 * Team presets: a group of agents, each with a specialty already assigned.
 * Applying one adds an agent per template, named "<Template name> Agent",
 * and a specialist made from that template (its instructions, role models
 * and added roles) that the agent owns. Applying a preset again, or one
 * that shares templates with an earlier one, adds only what is missing.
 */

export interface TeamPreset {
	id: string;
	name: string;
	description: string;
	/** Built-in template ids, in the order the agents are added (every preset ends with a Research Agent). */
	templates: string[];
}

export const TEAM_PRESETS: TeamPreset[] = [
	// Full teams: an agent per specialty, each in its own folder and branch,
	// so independent pieces of a long plan run side by side. The Team chat
	// gives each subtask to the specialist that fits and still keeps a
	// feature with one owner end to end (hand-offs between layers cost more
	// than they save), so a big team costs nothing while its agents are idle.
	{
		id: "web-app",
		name: "Web app",
		description:
			"Frontend, UI, UX, backend, API, database, QA, security, DevOps, performance, docs and research.",
		templates: [
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
		],
	},
	{
		id: "game-dev",
		name: "Game development",
		description:
			"Game builder, UI, UX, backend, performance, QA, DevOps, docs and research.",
		templates: [
			"gamedev",
			"ui",
			"ux",
			"backend",
			"performance",
			"qa",
			"devops",
			"documentation",
			"research",
		],
	},
	{
		id: "mobile-app",
		name: "Mobile app",
		description:
			"Mobile builder, UI, UX, backend, API, database, QA, security, performance, DevOps and research.",
		templates: [
			"mobile",
			"ui",
			"ux",
			"backend",
			"api",
			"database",
			"qa",
			"security",
			"performance",
			"devops",
			"research",
		],
	},
	{
		id: "desktop-app",
		name: "Desktop app",
		description:
			"Desktop builder, frontend, UI, UX, backend, database, QA, security, performance, DevOps, docs and research.",
		templates: [
			"desktop",
			"frontend",
			"ui",
			"ux",
			"backend",
			"database",
			"qa",
			"security",
			"performance",
			"devops",
			"documentation",
			"research",
		],
	},
	{
		id: "backend-service",
		name: "Backend / API service",
		description:
			"Backend, API, database, security, performance, QA, DevOps, docs and research.",
		templates: [
			"backend",
			"api",
			"database",
			"security",
			"performance",
			"qa",
			"devops",
			"documentation",
			"research",
		],
	},
	{
		id: "minimal",
		name: "Small team",
		description: "Frontend, backend, UI, QA and research.",
		templates: ["frontend", "backend", "ui", "qa", "research"],
	},
];

export function findTeamPreset(id: string): TeamPreset | undefined {
	return TEAM_PRESETS.find((p) => p.id === id);
}

/** The agent's name for a template: "<Template name> Agent". */
export function presetAgentName(templateName: string): string {
	return `${templateName} Agent`;
}

export interface PresetStep {
	templateId: string;
	templateName: string;
	agentName: string;
	/** An agent of that name already in the team, if any. */
	agentWorkspaceId?: string;
	/** "create": a new specialist; "assign": give an existing one this agent; "keep": nothing to do. */
	specialist: "create" | "assign" | "keep";
	specialistId?: string;
}

/**
 * What applying a preset adds to a team, without changing anything: an
 * agent per template (unless one of that name exists), and the template's
 * specialist for it (unless the team already has a specialist of that
 * name; one without an agent is given this agent).
 */
export function planPreset(
	preset: TeamPreset,
	templates: Array<{ id: string; name: string }>,
	agents: Array<{ workspaceId: string; name: string }>,
	specialists: Array<{ id: string; name: string; agentWorkspaceId?: string }>,
): PresetStep[] {
	const steps: PresetStep[] = [];
	for (const templateId of preset.templates) {
		const template = templates.find((t) => t.id === templateId);
		if (!template) continue;
		const agentName = presetAgentName(template.name);
		const agent = agents.find(
			(a) => a.name.toLowerCase() === agentName.toLowerCase(),
		);
		const existing = specialists.find(
			(s) => s.name.toLowerCase() === template.name.toLowerCase(),
		);
		steps.push({
			templateId,
			templateName: template.name,
			agentName,
			agentWorkspaceId: agent?.workspaceId,
			specialist: !existing
				? "create"
				: existing.agentWorkspaceId
					? "keep"
					: "assign",
			specialistId: existing?.id,
		});
	}
	return steps;
}
