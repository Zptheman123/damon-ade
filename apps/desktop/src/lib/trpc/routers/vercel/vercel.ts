import { workspaces } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { getSupersetHomeDir } from "main/lib/app-environment";
import { localDb } from "main/lib/local-db";
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

const workspaceInput = z.object({ workspaceId: z.string() });

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

		/** The team's website: its link, project and latest deployments. */
		site: publicProcedure
			.input(workspaceInput)
			.query(({ input }) =>
				guarded(() => teamSite(vercelDeps(), rootOf(input.workspaceId))),
			),

		link: publicProcedure
			.input(workspaceInput.extend({ projectId: z.string().min(1).max(200) }))
			.mutation(({ input }) =>
				guarded(() =>
					linkTeamToVercel(
						vercelDeps(),
						rootOf(input.workspaceId),
						input.projectId,
					),
				),
			),

		unlink: publicProcedure.input(workspaceInput).mutation(({ input }) => {
			unlinkTeamFromVercel(getSupersetHomeDir(), rootOf(input.workspaceId));
			return { linked: false };
		}),
	});
