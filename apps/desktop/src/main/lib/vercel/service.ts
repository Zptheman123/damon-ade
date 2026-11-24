import {
	loadProjectConfig,
	saveProjectConfig,
	type VercelLink,
} from "main/lib/project-type/config";
import { VercelApi, type VercelDeployment, type VercelProject } from "./api";
import {
	type Cipher,
	loadVercelAccount,
	loadVercelToken,
	type VercelAccount,
} from "./connection";
import { suggestVercelProject, type VercelSuggestion } from "./suggest";

/**
 * What ADE (its UI and the agents' Vercel tools) knows about a team's
 * website: the user's Vercel connection, the project the team is linked
 * to, and its latest deployments.
 */

export interface VercelDeps {
	homeDir: string;
	cipher: Cipher;
	fetchFn?: typeof fetch;
}

export interface TeamSite {
	connected: boolean;
	account: VercelAccount | null;
	link: VercelLink | null;
	project?: VercelProject;
	deployments?: VercelDeployment[];
	/** Not linked yet: the project it most likely is. */
	suggestion?: VercelSuggestion | null;
	error?: string;
}

export class VercelNotConnected extends Error {
	constructor() {
		super(
			"Vercel is not connected. The user connects it in ADE: Settings > Integrations > Vercel.",
		);
	}
}

/** The API in the account's scope, or in a linked project's own scope. */
export function vercelApi(deps: VercelDeps, teamId?: string | null): VercelApi {
	const account = loadVercelAccount(deps.homeDir);
	const token = account ? loadVercelToken(deps.homeDir, deps.cipher) : null;
	if (!account || !token) throw new VercelNotConnected();
	return new VercelApi(
		token,
		teamId === undefined ? account.teamId : teamId,
		deps.fetchFn,
	);
}

export function isVercelConnected(deps: VercelDeps): boolean {
	return (
		!!loadVercelAccount(deps.homeDir) &&
		!!loadVercelToken(deps.homeDir, deps.cipher)
	);
}

export function teamVercelLink(homeDir: string, root: string) {
	return loadProjectConfig(homeDir, root).vercel ?? null;
}

export async function teamSite(
	deps: VercelDeps,
	root: string,
	options: { deployments?: number } = {},
): Promise<TeamSite> {
	const account = loadVercelAccount(deps.homeDir);
	const link = teamVercelLink(deps.homeDir, root);
	if (!isVercelConnected(deps)) {
		return { connected: false, account: null, link };
	}
	try {
		if (!link) {
			const projects = await vercelApi(deps).projects();
			return {
				connected: true,
				account,
				link,
				suggestion: suggestVercelProject(root, projects),
			};
		}
		const api = vercelApi(deps, link.teamId);
		const [project, deployments] = await Promise.all([
			api.project(link.projectId),
			api.deployments(link.projectId, { limit: options.deployments ?? 6 }),
		]);
		return { connected: true, account, link, project, deployments };
	} catch (error) {
		return {
			connected: true,
			account,
			link,
			error: (error as Error).message,
		};
	}
}

export async function linkTeamToVercel(
	deps: VercelDeps,
	root: string,
	projectIdOrName: string,
): Promise<VercelLink> {
	const account = loadVercelAccount(deps.homeDir);
	const project = await vercelApi(deps).project(projectIdOrName);
	const link: VercelLink = {
		projectId: project.id,
		projectName: project.name,
		teamId: account?.teamId ?? null,
		linkedAt: new Date().toISOString(),
	};
	const config = loadProjectConfig(deps.homeDir, root);
	saveProjectConfig(deps.homeDir, root, { ...config, vercel: link });
	return link;
}

export function unlinkTeamFromVercel(homeDir: string, root: string): void {
	const { vercel: _, ...config } = loadProjectConfig(homeDir, root);
	saveProjectConfig(homeDir, root, config);
}

/** "3 min ago", for people and models alike. */
export function ago(ms: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} days ago`;
}
