import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Claude Code skills an agent can use: the user's own
 * (~/.claude/skills), the project's (.claude/skills in the repository) and
 * those of installed plugins ("plugin:skill"). ADE's agents run Claude Code
 * with the user's configuration, so these are the skills they have. The
 * Team chat lists them and assigns the right ones to each subtask.
 */

export interface SkillInfo {
	/** What the Skill tool takes: "frontend-design", or "vercel:deploy". */
	name: string;
	description: string;
	source: "personal" | "project" | "plugin";
}

/** A skill name as Claude Code writes it (plugin skills: "plugin:skill"). */
export const SKILL_NAME =
	/^[A-Za-z0-9][\w.-]{0,63}(?::[A-Za-z0-9][\w.-]{0,63})?$/;

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** The name and description in a SKILL.md's front matter. */
export function readSkillFile(
	text: string,
): { name?: string; description?: string } | undefined {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return undefined;
	const lines = match[1].split(/\r?\n/);
	const field = (key: string): string | undefined => {
		const index = lines.findIndex((l) => l.startsWith(`${key}:`));
		if (index < 0) return undefined;
		let value = lines[index].slice(key.length + 1).trim();
		// Folded or literal blocks (">" or "|"): the indented lines after it.
		if (/^[>|][-+]?$/.test(value)) {
			const block: string[] = [];
			for (const line of lines.slice(index + 1)) {
				if (!/^\s+/.test(line)) break;
				block.push(line.trim());
			}
			value = block.join(" ");
		}
		return value.replace(/^(["'])([\s\S]*)\1$/, "$2").trim() || undefined;
	};
	return { name: field("name"), description: field("description") };
}

function skillsIn(
	dir: string,
	source: SkillInfo["source"],
	prefix = "",
): SkillInfo[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const skills: SkillInfo[] = [];
	for (const entry of entries) {
		const file = join(dir, entry, "SKILL.md");
		if (!existsSync(file)) continue;
		let meta: ReturnType<typeof readSkillFile>;
		try {
			meta = readSkillFile(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		const name = `${prefix}${meta?.name || entry}`;
		if (!SKILL_NAME.test(name)) continue;
		skills.push({
			name,
			description: (meta?.description ?? "").replace(/\s+/g, " ").slice(0, 400),
			source,
		});
	}
	return skills;
}

/** Plugins that are installed and not turned off in Claude Code's settings. */
function pluginDirs(claudeDir: string): Array<{ plugin: string; dir: string }> {
	let installed: { plugins?: Record<string, Array<{ installPath?: string }>> };
	try {
		installed = JSON.parse(
			readFileSync(
				join(claudeDir, "plugins", "installed_plugins.json"),
				"utf8",
			),
		);
	} catch {
		return [];
	}
	let enabled: Record<string, boolean> = {};
	try {
		enabled =
			JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"))
				.enabledPlugins ?? {};
	} catch {
		// No settings: every installed plugin counts.
	}
	const dirs: Array<{ plugin: string; dir: string }> = [];
	for (const [id, installs] of Object.entries(installed.plugins ?? {})) {
		if (enabled[id] === false) continue;
		const path = installs?.[installs.length - 1]?.installPath;
		if (path) dirs.push({ plugin: id.split("@")[0], dir: path });
	}
	return dirs;
}

/** Every skill an agent working in `projectRoot` can use, without duplicates. */
export function listSkills(options: {
	claudeDir?: string;
	projectRoot?: string;
}): SkillInfo[] {
	const claudeDir = options.claudeDir ?? claudeConfigDir();
	const all = [
		...(options.projectRoot
			? skillsIn(join(options.projectRoot, ".claude", "skills"), "project")
			: []),
		...skillsIn(join(claudeDir, "skills"), "personal"),
		...pluginDirs(claudeDir).flatMap(({ plugin, dir }) =>
			skillsIn(join(dir, "skills"), "plugin", `${plugin}:`),
		),
	];
	const seen = new Set<string>();
	return all.filter((skill) => {
		if (seen.has(skill.name)) return false;
		seen.add(skill.name);
		return true;
	});
}

/** The note an agent's prompt gets about the skills chosen for its work. */
export function skillsNote(skills: string[] | undefined): string {
	if (!skills?.length) return "";
	return `\n\n## Skills to use\nThe Coordinator chose these Claude Code skills for this work: ${skills.map((s) => `\`${s}\``).join(", ")}. Before you start, load each one with the Skill tool and follow its guidance as you work (where it conflicts with this task, the task wins).\n`;
}
