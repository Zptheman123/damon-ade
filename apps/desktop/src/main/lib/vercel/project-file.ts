import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { VercelLink } from "main/lib/project-type/config";

/**
 * The team's Vercel project, written where the Vercel CLI looks for it:
 * `.vercel/project.json` in each of the team's folders (its repository and
 * every agent's worktree). `vercel deploy`, `vercel env pull` and the Vercel
 * plugin then use the project the user chose in Team Settings, without
 * asking and without an agent picking one. The folder ignores itself
 * (`.vercel/.gitignore`), so nothing reaches a commit.
 */

interface ProjectFile {
	projectId?: string;
	orgId?: string;
	projectName?: string;
	[key: string]: unknown;
}

function read(path: string): ProjectFile | undefined {
	try {
		const data = JSON.parse(readFileSync(path, "utf8"));
		return data && typeof data === "object" ? data : undefined;
	} catch {
		return undefined;
	}
}

/** Point the folder's Vercel CLI at the team's project. Returns whether it changed. */
export function writeVercelProjectFile(
	folder: string,
	link: VercelLink,
): boolean {
	if (!link.orgId || !existsSync(folder)) return false;
	const dir = join(folder, ".vercel");
	const path = join(dir, "project.json");
	const existing = read(path) ?? {};
	if (
		existing.projectId === link.projectId &&
		existing.orgId === link.orgId &&
		existing.projectName === link.projectName
	) {
		return false;
	}
	mkdirSync(dir, { recursive: true });
	const ignore = join(dir, ".gitignore");
	if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
	// Keep what the CLI stored (its build settings); only the project changes.
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				...existing,
				projectId: link.projectId,
				orgId: link.orgId,
				projectName: link.projectName,
			},
			null,
			2,
		)}\n`,
	);
	return true;
}

/** Unlinked: forget the project in that folder, if it is still that one. */
export function removeVercelProjectFile(
	folder: string,
	projectId: string,
): void {
	const path = join(folder, ".vercel", "project.json");
	if (read(path)?.projectId === projectId) rmSync(path, { force: true });
}
