import { projects, workspaces, worktrees } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getSupersetHomeDir } from "main/lib/app-environment";
import { localDb } from "main/lib/local-db";
import { loadProjectConfig } from "main/lib/project-type/config";
import { VercelApi } from "main/lib/vercel/api";
import {
	clearVercelConnection,
	loadVercelAccount,
	saveVercelConnection,
	updateVercelAccount,
} from "main/lib/vercel/connection";
import { electronCipher } from "main/lib/vercel/electron-cipher";
import {
	removeVercelMcpConfigs,
	syncVercelMcpConfig,
	type VercelMcpDeps,
} from "main/lib/vercel/mcp";
import {
	removeVercelProjectFile,
	writeVercelProjectFile,
} from "main/lib/vercel/project-file";
import {
	allVercelProjects,
	linkTeamToVercel,
	teamSite,
	unlinkTeamFromVercel,
	type VercelDeps,
	vercelApi,
} from "main/lib/vercel/service";
import { env } from "shared/env.shared";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { defaultWorkflowRouterDeps } from "../workflow/workflow";
import { getBranchWorkspace } from "../workspaces/utils/db-helpers";

/**
 * Vercel: the user connects their account once (Settings > Integrations),
 * then links each team to the Vercel project that is its website. ADE's
 * agents get read-only Vercel tools (main/lib/vercel/mcp.ts) while it is connected.
 * The token stays in the main process, encrypted at rest.
 */

function vercelDeps(): VercelDeps {
	return { homeDir: getSupersetHomeDir(), cipher: electronCipher() };
}

function rootOf(workspaceId: string): string {
	try {
		return defaultWorkflowRouterDeps.resolveWorkspace(workspaceId).project.root;
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: (error as Error).message,
		});
	}
}

/** A team, by one of its workspaces (the top bar) or by its id (Team Settings). */
const teamInput = z.object({
	workspaceId: z.string().optional(),
	projectId: z.string().optional(),
});

function teamOf(input: { workspaceId?: string; projectId?: string }) {
	let workspaceId = input.workspaceId;
	let projectId = input.projectId;
	if (!workspaceId && !projectId) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Which team?" });
	}
	if (!workspaceId && projectId) {
		workspaceId = getBranchWorkspace(projectId)?.id;
		if (!workspaceId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"This team has no repository yet. Choose its repository first.",
			});
		}
	}
	if (!projectId && workspaceId) {
		projectId = localDb
			.select({ projectId: workspaces.projectId })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.get()?.projectId;
	}
	return { root: rootOf(workspaceId as string), projectId };
}

/** The team's folders: its repository and every agent's worktree. */
function teamFolders(root: string, projectId: string | undefined): string[] {
	const folders = new Set([root]);
	if (projectId) {
		try {
			const main = localDb
				.select({ path: projects.mainRepoPath })
				.from(projects)
				.where(eq(projects.id, projectId))
				.get();
			if (main?.path) folders.add(main.path);
			for (const w of localDb
				.select({ path: worktrees.path })
				.from(worktrees)
				.where(eq(worktrees.projectId, projectId))
				.all()) {
				folders.add(w.path);
			}
		} catch {
			// The repository alone, then.
		}
	}
	return [...folders];
}

export function defaultVercelMcpDeps(): VercelMcpDeps {
	return { ...vercelDeps(), rootOf };
}

/** Give (or take away) every workspace's sessions the Vercel tools. */
function syncAllMcpConfigs() {
	const deps = vercelDeps();
	let ids: string[] = [];
	try {
		ids = localDb
			.select({ id: workspaces.id })
			.from(workspaces)
			.all()
			.map((w) => w.id);
	} catch {
		// No workspaces yet.
	}
	for (const id of ids) {
		syncVercelMcpConfig(deps, id, env.DESKTOP_NOTIFICATIONS_PORT);
	}
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof TRPCError) throw error;
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: (error as Error).message,
		});
	}
}

export const createVercelRouter = () =>
	router({
		/** Whether Vercel is connected, as whom, and in which scope. */
		status: publicProcedure.query(() => {
			const deps = vercelDeps();
			const account = loadVercelAccount(deps.homeDir);
			let connected = false;
			try {
				vercelApi(deps);
				connected = true;
			} catch {
				connected = false;
			}
			return { connected, account: connected ? account : null };
		}),

		/** Connect with an access token the user created on vercel.com. */
		connect: publicProcedure
			.input(z.object({ token: z.string().trim().min(8).max(500) }))
			.mutation(({ input }) =>
				guarded(async () => {
					const api = new VercelApi(input.token);
					const user = await api.user();
					const deps = vercelDeps();
					saveVercelConnection(deps.homeDir, deps.cipher, input.token, {
						username: user.username,
						name: user.name ?? null,
						teamId: null,
						teamName: null,
						connectedAt: new Date().toISOString(),
					});
					syncAllMcpConfigs();
					return { username: user.username, name: user.name ?? null };
				}),
			),

		disconnect: publicProcedure.mutation(() => {
			const deps = vercelDeps();
			clearVercelConnection(deps.homeDir);
			removeVercelMcpConfigs(deps.homeDir);
			return { connected: false };
		}),

		/** The personal account and the Vercel teams the token can use. */
		teams: publicProcedure.query(() =>
			guarded(async () => vercelApi(vercelDeps(), null).teams()),
		),

		/** Work in the personal account (null) or one of the user's teams. */
		setScope: publicProcedure
			.input(
				z.object({
					teamId: z.string().nullable(),
					teamName: z.string().nullable().optional(),
				}),
			)
			.mutation(({ input }) =>
				updateVercelAccount(getSupersetHomeDir(), {
					teamId: input.teamId,
					teamName: input.teamName ?? null,
				}),
			),

		projects: publicProcedure
			.input(z.object({ search: z.string().max(100).optional() }))
			.query(({ input }) =>
				guarded(async () => vercelApi(vercelDeps()).projects(input.search)),
			),

		/** Every project the token can reach, by scope (personal account, each team). */
		allProjects: publicProcedure
			.input(z.object({ search: z.string().max(100).optional() }))
			.query(({ input }) =>
				guarded(() => allVercelProjects(vercelDeps(), input.search)),
			),

		/** The team's website: its link, project and latest deployments. */
		site: publicProcedure
			.input(teamInput)
			.query(({ input }) =>
				guarded(() => teamSite(vercelDeps(), teamOf(input).root)),
			),

		/**
		 * The user links the team to its project. Every folder of the team then
		 * deploys there (.vercel/project.json), so no agent chooses a project.
		 */
		link: publicProcedure
			.input(
				teamInput.extend({
					vercelProjectId: z.string().min(1).max(200),
					/** The project's Vercel team (null: personal); left out: Settings' scope. */
					teamId: z.string().nullable().optional(),
					teamName: z.string().nullable().optional(),
				}),
			)
			.mutation(({ input }) =>
				guarded(async () => {
					const { root, projectId } = teamOf(input);
					const link = await linkTeamToVercel(
						vercelDeps(),
						root,
						input.vercelProjectId,
						input.teamId === undefined
							? undefined
							: { teamId: input.teamId, teamName: input.teamName },
					);
					for (const folder of teamFolders(root, projectId)) {
						try {
							writeVercelProjectFile(folder, link);
						} catch {
							// A folder that is gone or locked: its next run writes it.
						}
					}
					return link;
				}),
			),

		unlink: publicProcedure.input(teamInput).mutation(({ input }) => {
			const { root, projectId } = teamOf(input);
			const home = getSupersetHomeDir();
			const old = loadProjectConfig(home, root).vercel;
			unlinkTeamFromVercel(home, root);
			if (old) {
				for (const folder of teamFolders(root, projectId)) {
					try {
						removeVercelProjectFile(folder, old.projectId);
					} catch {
						// Best effort.
					}
				}
			}
			return { linked: false };
		}),
	});
