import type { ProjectConfig } from "./config";
import { PROJECT_TYPE_INFO } from "./detect";

/**
 * What agents are told about the project: its type, and how the user runs
 * it (the run targets saved in ADE). Empty when nothing is configured.
 */
export function projectPromptNote(config: ProjectConfig): string {
	if (!config.type && !config.targets.length) return "";
	const lines = ["## This project"];
	if (config.type) {
		lines.push(
			`Type: ${PROJECT_TYPE_INFO[config.type].name}${config.framework ? ` (${config.framework})` : ""}.`,
		);
	}
	if (config.targets.length) {
		lines.push(
			"How the user runs it (from ADE's Run panel). If you start one to check your work, stop it before you finish; servers must listen on localhost only:",
			...config.targets.map(
				(t) =>
					`- ${t.name}: \`${t.command}${t.args ? ` ${t.args}` : ""}\`${t.cwd && t.cwd !== "." ? ` in ${t.cwd}` : ""}${t.url ? ` (${t.url})` : ""}`,
			),
		);
	}
	return lines.join("\n");
}
