import { TRPCError } from "@trpc/server";
import { dialog } from "electron";
import { getSupersetHomeDir } from "main/lib/app-environment";
import {
	type Attachment,
	AttachmentError,
	attachBytes,
	attachFile,
	attachmentPreview,
	MAX_ATTACHMENTS,
	removeAttachment,
} from "main/lib/attachments/attachments";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { defaultWorkflowRouterDeps } from "../workflow/workflow";

/**
 * Attachments for the composers (Tasks, Team plans, the Claude Code message
 * box). ADE keeps its own copy per team; sending attaches the ids to the
 * task, whose runs read the files with Claude Code's Read tool.
 */

function projectKey(workspaceId: string): string {
	return defaultWorkflowRouterDeps.resolveWorkspace(workspaceId).project.key;
}

function withPreview(attachment: Attachment) {
	return { ...attachment, preview: attachmentPreview(attachment) ?? null };
}

function attachOne(fn: () => Attachment) {
	try {
		return { ok: true as const, attachment: withPreview(fn()) };
	} catch (error) {
		return {
			ok: false as const,
			error:
				error instanceof AttachmentError
					? error.message
					: `Could not attach: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

const FILTERS = [
	{
		name: "Supported files",
		extensions: [
			"png",
			"jpg",
			"jpeg",
			"webp",
			"gif",
			"pdf",
			"txt",
			"md",
			"json",
			"csv",
			"ts",
			"tsx",
			"js",
			"jsx",
			"py",
			"go",
			"rs",
			"java",
			"cs",
			"css",
			"html",
			"yaml",
			"yml",
			"toml",
			"sql",
			"sh",
		],
	},
	{ name: "All files", extensions: ["*"] },
];

export const createAttachmentsRouter = () =>
	router({
		/** Files picked in the system dialog. */
		pick: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.mutation(async ({ input }) => {
				const result = await dialog.showOpenDialog({
					title: "Attach files",
					properties: ["openFile", "multiSelections"],
					filters: FILTERS,
				});
				if (result.canceled) return [];
				const key = projectKey(input.workspaceId);
				return result.filePaths
					.slice(0, MAX_ATTACHMENTS)
					.map((path) =>
						attachOne(() => attachFile(getSupersetHomeDir(), key, path)),
					);
			}),

		/** Files dropped onto a composer (their paths). */
		addPaths: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					paths: z.array(z.string().min(1)).max(MAX_ATTACHMENTS),
				}),
			)
			.mutation(({ input }) => {
				const key = projectKey(input.workspaceId);
				return input.paths.map((path) =>
					attachOne(() => attachFile(getSupersetHomeDir(), key, path)),
				);
			}),

		/** A pasted image or a captured screenshot. */
		addData: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					name: z.string().min(1).max(200),
					base64: z.string().max(20 * 1024 * 1024),
				}),
			)
			.mutation(({ input }) => {
				const key = projectKey(input.workspaceId);
				return attachOne(() =>
					attachBytes(
						getSupersetHomeDir(),
						key,
						input.name,
						Buffer.from(input.base64, "base64"),
					),
				);
			}),

		/** Remove an attachment that was not sent. */
		remove: publicProcedure
			.input(z.object({ workspaceId: z.string(), id: z.string() }))
			.mutation(({ input }) => {
				try {
					removeAttachment(
						getSupersetHomeDir(),
						projectKey(input.workspaceId),
						input.id,
					);
				} catch (error) {
					throw new TRPCError({ code: "BAD_REQUEST", message: String(error) });
				}
				return { removed: input.id };
			}),
	});
