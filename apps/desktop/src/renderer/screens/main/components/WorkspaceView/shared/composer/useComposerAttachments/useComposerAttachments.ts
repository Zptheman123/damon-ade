import { toast } from "@superset/ui/sonner";
import { type ClipboardEvent, type DragEvent, useCallback } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type DraftAttachment,
	useComposerDrafts,
} from "renderer/stores/composer-drafts";

const MAX = 10;
const EMPTY: DraftAttachment[] = [];

function toBase64(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

type AddResult =
	| { ok: true; attachment: NonNullable<DraftAttachment["attachment"]> }
	| { ok: false; error: string };

/**
 * A composer's attachments: pick, drop and paste add files (ADE keeps a
 * copy per team), remove takes an unsent one back, and `ids` are what a
 * send passes on. Kept per surface while ADE runs.
 */
export function useComposerAttachments(workspaceId: string, surface: string) {
	const key = `${workspaceId}:${surface}`;
	const items = useComposerDrafts((s) => s.drafts[key] ?? EMPTY);
	const update = useComposerDrafts((s) => s.update);
	const pickMutation = electronTrpc.attachments.pick.useMutation();
	const addPaths = electronTrpc.attachments.addPaths.useMutation();
	const addData = electronTrpc.attachments.addData.useMutation();
	const removeMutation = electronTrpc.attachments.remove.useMutation();

	const settle = useCallback(
		(localKey: string, result: AddResult, name: string) => {
			update(key, (list) =>
				list.map((item) =>
					item.key !== localKey
						? item
						: result.ok
							? {
									key: result.attachment.id,
									name: result.attachment.name,
									status: "ready",
									attachment: result.attachment,
								}
							: { key: localKey, name, status: "error", error: result.error },
				),
			);
		},
		[key, update],
	);

	const room = useCallback(() => {
		const left = MAX - (useComposerDrafts.getState().drafts[key] ?? []).length;
		if (left <= 0) toast.error(`At most ${MAX} attachments per message.`);
		return left;
	}, [key]);

	const pick = useCallback(async () => {
		if (room() <= 0) return;
		const results = await pickMutation.mutateAsync({ workspaceId });
		for (const result of results.slice(0, room())) {
			const localKey = crypto.randomUUID();
			const name = result.ok ? result.attachment.name : "file";
			update(key, (list) => [
				...list,
				{ key: localKey, name, status: "adding" },
			]);
			settle(localKey, result, name);
		}
	}, [pickMutation, workspaceId, key, update, settle, room]);

	const addFiles = useCallback(
		async (files: File[]) => {
			for (const file of files.slice(0, Math.max(0, room()))) {
				const localKey = crypto.randomUUID();
				update(key, (list) => [
					...list,
					{
						key: localKey,
						name: file.name || "pasted image",
						status: "adding",
					},
				]);
				try {
					const path = window.webUtils?.getPathForFile(file);
					const result = path
						? (await addPaths.mutateAsync({ workspaceId, paths: [path] }))[0]
						: await addData.mutateAsync({
								workspaceId,
								name:
									file.name ||
									`pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`,
								base64: await toBase64(file),
							});
					settle(localKey, result as AddResult, file.name);
				} catch (error) {
					settle(
						localKey,
						{
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						},
						file.name,
					);
				}
			}
		},
		[addPaths, addData, workspaceId, key, update, settle, room],
	);

	/** Add an image already captured (a preview screenshot), as base64. */
	const addImage = useCallback(
		async (name: string, base64: string) => {
			if (room() <= 0) return;
			const localKey = crypto.randomUUID();
			update(key, (list) => [
				...list,
				{ key: localKey, name, status: "adding" },
			]);
			const result = await addData.mutateAsync({ workspaceId, name, base64 });
			settle(localKey, result as AddResult, name);
		},
		[addData, workspaceId, key, update, settle, room],
	);

	const remove = useCallback(
		(itemKey: string) => {
			const item = (useComposerDrafts.getState().drafts[key] ?? []).find(
				(i) => i.key === itemKey,
			);
			update(key, (list) => list.filter((i) => i.key !== itemKey));
			if (item?.attachment) {
				removeMutation.mutate({ workspaceId, id: item.attachment.id });
			}
		},
		[key, update, removeMutation, workspaceId],
	);

	/** After a send: the files now belong to the task; forget the draft. */
	const clear = useCallback(() => update(key, () => []), [key, update]);

	const onPaste = useCallback(
		(event: ClipboardEvent) => {
			const files = [...event.clipboardData.items]
				.filter((item) => item.kind === "file")
				.map((item) => item.getAsFile())
				.filter((f): f is File => !!f);
			if (files.length) {
				event.preventDefault();
				void addFiles(files);
			}
		},
		[addFiles],
	);

	const onDrop = useCallback(
		(event: DragEvent) => {
			const files = [...event.dataTransfer.files];
			if (!files.length) return;
			event.preventDefault();
			event.stopPropagation();
			void addFiles(files);
		},
		[addFiles],
	);

	return {
		items,
		ids: items
			.filter((i) => i.status === "ready" && i.attachment)
			.map((i) => i.attachment?.id as string),
		busy: items.some((i) => i.status === "adding"),
		pick,
		addFiles,
		addImage,
		remove,
		clear,
		onPaste,
		onDrop,
	};
}
