import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { app, shell } from "electron";
import { getSupersetHomeDir } from "main/lib/app-environment";
import {
	loadProjectConfig,
	mergeTargets,
	type RunTarget,
	saveProjectConfig,
} from "main/lib/project-type/config";
import { detectProject, PROJECT_TYPE_INFO } from "main/lib/project-type/detect";
import {
	browserPreview,
	getRunManager,
	launchPreview,
	openTargetInBrowser,
	type RunEvent,
	sendLocalRequest,
} from "main/lib/run-targets";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { defaultWorkflowRouterDeps } from "../workflow/workflow";

/**
 * Run targets: start, stop and restart a team's dev servers, apps and
 * commands in a workspace, read their logs, and send test requests to a
 * local backend. Only targets saved in the team's configuration run, and
 * only when the user asks: choosing a team never starts anything.
 */

const ref = z.object({ workspaceId: z.string(), targetId: z.string() });

let quitHooked = false;
function stopAllOnQuit() {
	if (quitHooked) return;
	quitHooked = true;
	app.on("before-quit", () => {
		void getRunManager().stopAll();
	});
}

function context(workspaceId: string) {
	try {
		const ctx = defaultWorkflowRouterDeps.resolveWorkspace(workspaceId);
		return {
			root: ctx.project.root,
			worktree: ctx.worktreePath,
			config: loadProjectConfig(getSupersetHomeDir(), ctx.project.root),
		};
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: (error as Error).message,
		});
	}
}

function targetOf(workspaceId: string, targetId: string) {
	const ctx = context(workspaceId);
	const target = ctx.config.targets.find((t) => t.id === targetId);
	if (!target) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "That run target is not in this team's configuration.",
		});
	}
	return { ...ctx, target };
}

/**
 * A saved target, or one ADE detected and the user just chose (from the
 * Preview button): that one is saved first, as "Add" in Run would.
 */
function savedOrDetected(workspaceId: string, targetId: string) {
	const ctx = context(workspaceId);
	const saved = ctx.config.targets.find((t) => t.id === targetId);
	if (saved) return { ...ctx, target: saved };
	let detected: RunTarget | undefined;
	try {
		detected = detectProject(ctx.root).targets.find((t) => t.id === targetId);
	} catch {
		// Not detectable: same as not found.
	}
	if (!detected) return targetOf(workspaceId, targetId);
	const config = saveProjectConfig(getSupersetHomeDir(), ctx.root, {
		...ctx.config,
		targets: mergeTargets(ctx.config.targets, [detected]),
	});
	return { ...ctx, config, target: detected };
}

function failed(error: unknown): never {
	throw new TRPCError({
		code: "BAD_REQUEST",
		message: (error as Error).message,
	});
}

export const createRunTargetsRouter = () => {
	stopAllOnQuit();
	return router({
		/** The team's targets with their state here, plus detected suggestions. */
		list: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				const ctx = context(input.workspaceId);
				const runs = getRunManager().list(input.workspaceId);
				let suggested: RunTarget[] = [];
				let framework = ctx.config.framework;
				try {
					const detection = detectProject(ctx.root);
					framework ??= detection.framework;
					suggested = detection.targets.filter(
						(t) => !ctx.config.targets.some((c) => c.id === t.id),
					);
				} catch {
					// Detection is a convenience.
				}
				const previewOf = (target: RunTarget) =>
					browserPreview(target, ctx.worktree, ctx.config.type ?? undefined);
				return {
					type: ctx.config.type ?? null,
					typeName: ctx.config.type
						? PROJECT_TYPE_INFO[ctx.config.type].name
						: null,
					framework: framework ?? null,
					worktree: ctx.worktree,
					targets: ctx.config.targets.map((target) => ({
						target,
						run: runs.find((r) => r.targetId === target.id) ?? null,
						/** Whether "Open localhost" can open it, and as what. */
						preview: previewOf(target),
					})),
					suggested,
					/** Detected, not saved yet: the Preview button offers them too. */
					suggestedPreviews: suggested.map((target) => ({
						target,
						preview: previewOf(target),
					})),
				};
			}),

		start: publicProcedure.input(ref).mutation(({ input }) => {
			const { worktree, target } = targetOf(input.workspaceId, input.targetId);
			try {
				return getRunManager().start({
					workspaceId: input.workspaceId,
					worktree,
					target,
				});
			} catch (error) {
				failed(error);
			}
		}),

		stop: publicProcedure.input(ref).mutation(async ({ input }) => {
			return (
				(await getRunManager().stop(input.workspaceId, input.targetId)) ?? null
			);
		}),

		restart: publicProcedure.input(ref).mutation(async ({ input }) => {
			const { worktree, target } = targetOf(input.workspaceId, input.targetId);
			try {
				return await getRunManager().restart({
					workspaceId: input.workspaceId,
					worktree,
					target,
				});
			} catch (error) {
				failed(error);
			}
		}),

		/**
		 * "Open localhost": open the target's local address in the system
		 * browser once it answers; with `start`, start it first ("Run and
		 * open"). Only this workspace's target, only loopback addresses, no
		 * model involved.
		 */
		openInBrowser: publicProcedure
			.input(ref.extend({ start: z.boolean().default(false) }))
			.mutation(async ({ input }) => {
				const ctx = targetOf(input.workspaceId, input.targetId);
				try {
					return await openTargetInBrowser({
						manager: getRunManager(),
						workspaceId: input.workspaceId,
						worktree: ctx.worktree,
						target: ctx.target,
						projectType: ctx.config.type ?? undefined,
						start: input.start,
						open: (url) => shell.openExternal(url),
					});
				} catch (error) {
					failed(error);
				}
			}),

		/**
		 * The Preview button: show the app. A web app opens at its local
		 * address; a desktop app starts in its own window; a mobile app
		 * starts and returns its device address. A detected target is saved
		 * on first use. Only when the user clicks; no model involved.
		 */
		preview: publicProcedure
			.input(ref.extend({ start: z.boolean().default(true) }))
			.mutation(async ({ input }) => {
				const ctx = savedOrDetected(input.workspaceId, input.targetId);
				try {
					return await launchPreview({
						manager: getRunManager(),
						workspaceId: input.workspaceId,
						worktree: ctx.worktree,
						target: ctx.target,
						projectType: ctx.config.type ?? undefined,
						start: input.start,
						open: (url) => shell.openExternal(url),
					});
				} catch (error) {
					failed(error);
				}
			}),

		logs: publicProcedure
			.input(ref)
			.query(({ input }) =>
				getRunManager().logs(input.workspaceId, input.targetId),
			),

		/** State changes and new log lines for a workspace's runs. */
		onEvent: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.subscription(({ input }) =>
				observable<RunEvent>((emit) => {
					const handler = (event: RunEvent) => {
						if (event.state.workspaceId === input.workspaceId) emit.next(event);
					};
					getRunManager().on("event", handler);
					return () => {
						getRunManager().off("event", handler);
					};
				}),
			),

		/** The request tab: one request to a server on this computer. */
		request: publicProcedure
			.input(
				z.object({
					method: z.enum([
						"GET",
						"POST",
						"PUT",
						"PATCH",
						"DELETE",
						"HEAD",
						"OPTIONS",
					]),
					url: z.string().url().max(2000),
					headers: z.record(z.string(), z.string()).optional(),
					body: z.string().max(1_000_000).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				try {
					return await sendLocalRequest(input);
				} catch (error) {
					failed(error);
				}
			}),
	});
};
