import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { VercelProject } from "./api";

/**
 * Which Vercel project a team's folder most likely is, from what is already
 * on disk: the Vercel CLI's link file (.vercel/project.json), the Git
 * remote matching the project's connected repository, or the folder name.
 * A suggestion only: the user confirms the link.
 */

export interface VercelSuggestion {
	project: VercelProject;
	because: string;
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** "owner/repo" for each remote in .git/config (worktrees point elsewhere). */
export function gitRemoteRepos(root: string): string[] {
	let gitDir = join(root, ".git");
	const pointer = readText(gitDir);
	if (pointer?.startsWith("gitdir:")) {
		// A worktree: its config is in the main repository's .git.
		gitDir = join(pointer.slice(7).trim(), "..", "..");
	}
	const config = readText(join(gitDir, "config")) ?? "";
	const repos: string[] = [];
	for (const match of config.matchAll(/url\s*=\s*(\S+)/g)) {
		const repo = match[1].match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
		if (repo) repos.push(repo[1].toLowerCase());
	}
	return repos;
}

function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export function suggestVercelProject(
	root: string,
	projects: VercelProject[],
): VercelSuggestion | null {
	const linkFile = readText(join(root, ".vercel", "project.json"));
	if (linkFile) {
		try {
			const { projectId } = JSON.parse(linkFile) as { projectId?: string };
			const project = projects.find((p) => p.id === projectId);
			if (project) {
				return { project, because: "the Vercel CLI linked this folder to it" };
			}
		} catch {
			// Not JSON: ignore.
		}
	}
	const repos = gitRemoteRepos(root);
	const byRepo = projects.find(
		(p) => p.repo && repos.includes(p.repo.toLowerCase()),
	);
	if (byRepo) {
		return {
			project: byRepo,
			because: `it deploys ${byRepo.repo}, this folder's Git repository`,
		};
	}
	const folder = slug(basename(root));
	const byName = projects.find((p) => slug(p.name) === folder);
	return byName
		? { project: byName, because: "it has this folder's name" }
		: null;
}
