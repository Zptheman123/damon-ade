import { projects } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getSupersetHomeDir } from "main/lib/app-environment";
import { localDb } from "main/lib/local-db";
import {
	loadProjectConfig,
	mergeTargets,
	type RunTarget,
	saveProjectConfig,
} from "main/lib/project-type/config";
import {
	detectProject,
	PROJECT_TYPE_INFO,
	PROJECT_TYPES,
	type ProjectType,
} from "main/lib/project-type/detect";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { defaultWorkflowRouterDeps } from "../workflow/workflow";

/**
 * A team's project type and run targets. Detection reads safe metadata
 * only (it never runs repository code); the user confirms the type, and can
 * change it at any time without losing agents, tasks or history.
 */

const runTarget = z.object({
	id: z.string().min(1).max(200),
	name: z.string().trim().min(1).max(120),
	kind: z.enum([
		"web",
		"service",
		"mobile",
		"desktop",
		"game",
		"cli",
		"test",
		"custom",
	]),
	cwd: z.string().max(500),
	command: z.string().max(2000),
	url: z.string().max(500).optional(),
	prerequisite: z.string().max(500).optional(),
	lan: z.boolean().optional(),
	args: z.string().max(2000).optional(),
});

const where = z.union([
	z.object({ projectId: z.string() }),
	z.object({ workspaceId: z.string() }),
]);

/** The team's repository root, from its id or one of its workspaces. */
export function teamRoot(
	input: { projectId: string } | { workspaceId: string },
): string {
	if ("workspaceId" in input) {
		return defaultWorkflowRouterDeps.resolveWorkspace(input.workspaceId).project
			.root;
	}
	const project = localDb
		.select()
		.from(projects)
		.where(eq(projects.id, input.projectId))
		.get();
	if (!project?.mainRepoPath) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "This team has no repository yet.",
		});
	}
	return project.mainRepoPath;
}

export const createProjectConfigRouter = () =>
	router({
		/** The type choices, with a short explanation of each. */
		types: publicProcedure.query(() =>
			PROJECT_TYPES.map((id) => ({ id, ...PROJECT_TYPE_INFO[id] })),
		),

		/** Detect a folder before it is a team (New team dialog). Reads files only. */
		detect: publicProcedure
			.input(z.object({ path: z.string().min(1) }))
			.query(({ input }) => {
				try {
					return detectProject(input.path);
				} catch {
					return null;
				}
			}),

		/** A team's configuration, and what detection suggests for it. */
		get: publicProcedure.input(where).query(({ input }) => {
			const root = teamRoot(input);
			const config = loadProjectConfig(getSupersetHomeDir(), root);
			const detection = detectProject(root);
			return {
				root,
				config,
				detection,
				needsType: !config.type,
				info: config.type
					? { id: config.type, ...PROJECT_TYPE_INFO[config.type] }
					: null,
				/** Detected targets not yet in the configuration. */
				newTargets: detection.targets.filter(
					(t) => !config.targets.some((c) => c.id === t.id),
				),
			};
		}),

		/** Confirm or change the type; the first time, detected targets are added. */
		setType: publicProcedure
			.input(
				z.intersection(
					where,
					z.object({
						type: z.enum(
							PROJECT_TYPES as unknown as [ProjectType, ...ProjectType[]],
						),
						framework: z.string().max(120).optional(),
					}),
				),
			)
			.mutation(({ input }) => {
				const home = getSupersetHomeDir();
				const root = teamRoot(input);
				const config = loadProjectConfig(home, root);
				const detection = detectProject(root);
				return saveProjectConfig(home, root, {
					...config,
					type: input.type,
					framework:
						input.framework ??
						(detection.type === input.type
							? detection.framework
							: config.framework),
					confirmedAt: new Date().toISOString(),
					targets: config.targets.length
						? config.targets
						: mergeTargets([], detection.targets),
				});
			}),

		/** Add or update a run target (an edited target is never replaced by detection). */
		saveTarget: publicProcedure
			.input(z.intersection(where, z.object({ target: runTarget })))
			.mutation(({ input }) => {
				const home = getSupersetHomeDir();
				const root = teamRoot(input);
				const config = loadProjectConfig(home, root);
				const target: RunTarget = { ...input.target, edited: true };
				const targets = config.targets.some((t) => t.id === target.id)
					? config.targets.map((t) => (t.id === target.id ? target : t))
					: [...config.targets, target];
				return saveProjectConfig(home, root, { ...config, targets });
			}),

		removeTarget: publicProcedure
			.input(z.intersection(where, z.object({ id: z.string() })))
			.mutation(({ input }) => {
				const home = getSupersetHomeDir();
				const root = teamRoot(input);
				const config = loadProjectConfig(home, root);
				return saveProjectConfig(home, root, {
					...config,
					targets: config.targets.filter((t) => t.id !== input.id),
				});
			}),

		setPreviewLayout: publicProcedure
			.input(
				z.intersection(where, z.object({ layout: z.enum(["tab", "split"]) })),
			)
			.mutation(({ input }) => {
				const home = getSupersetHomeDir();
				const root = teamRoot(input);
				return saveProjectConfig(home, root, {
					...loadProjectConfig(home, root),
					previewLayout: input.layout,
				});
			}),
	});
