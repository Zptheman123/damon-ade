import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills, readSkillFile, skillsNote } from "./skills";

const root = mkdtempSync(join(tmpdir(), "ade-skills-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function skill(dir: string, folder: string, frontMatter: string) {
	mkdirSync(join(dir, folder), { recursive: true });
	writeFileSync(
		join(dir, folder, "SKILL.md"),
		`---\n${frontMatter}\n---\n\nBody.\n`,
	);
}

describe("skills", () => {
	it("reads a skill's name and description, folded or quoted", () => {
		expect(
			readSkillFile('---\nname: deploy\ndescription: "Ship it."\n---\n'),
		).toEqual({ name: "deploy", description: "Ship it." });
		expect(
			readSkillFile(
				"---\nname: ui\ndescription: >\n  Polished pages,\n  with care.\nlicense: MIT\n---\n",
			),
		).toEqual({ name: "ui", description: "Polished pages, with care." });
		expect(readSkillFile("no front matter")).toBeUndefined();
	});

	it("lists the user's, the repository's and enabled plugins' skills", () => {
		const claude = join(root, "claude");
		const project = join(root, "project");
		skill(
			join(claude, "skills"),
			"frontend-design",
			"name: frontend-design\ndescription: Distinctive interfaces.",
		);
		skill(
			join(project, ".claude", "skills"),
			"house-style",
			"description: Our style.",
		);
		const plugin = join(claude, "plugins", "cache", "vercel", "1.0.0");
		const off = join(claude, "plugins", "cache", "old", "1.0.0");
		skill(
			join(plugin, "skills"),
			"deploy",
			"name: deploy\ndescription: Deploy.",
		);
		skill(join(off, "skills"), "legacy", "name: legacy\ndescription: Old.");
		writeFileSync(
			join(claude, "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"vercel@official": [{ installPath: plugin }],
					"old@official": [{ installPath: off }],
				},
			}),
		);
		writeFileSync(
			join(claude, "settings.json"),
			JSON.stringify({ enabledPlugins: { "old@official": false } }),
		);

		const skills = listSkills({ claudeDir: claude, projectRoot: project });
		expect(skills.map((s) => `${s.name} (${s.source})`)).toEqual([
			"house-style (project)",
			"frontend-design (personal)",
			"vercel:deploy (plugin)",
		]);
		expect(skills[1].description).toBe("Distinctive interfaces.");
	});

	it("tells the agent to load its skills", () => {
		expect(skillsNote([])).toBe("");
		const note = skillsNote(["frontend-design", "vercel:deploy"]);
		expect(note).toContain("## Skills to use");
		expect(note).toContain("`frontend-design`, `vercel:deploy`");
		expect(note).toContain("Skill tool");
	});
});
