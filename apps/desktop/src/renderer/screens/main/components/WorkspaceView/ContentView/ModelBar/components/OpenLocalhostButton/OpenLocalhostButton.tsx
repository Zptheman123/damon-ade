import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { useRunTargets } from "../../hooks/useRunTargets";
import {
	OpenLocalhostView,
	type PreviewCandidate,
} from "./components/OpenLocalhostView";

interface OpenLocalhostButtonProps {
	workspaceId: string;
	runs: ReturnType<typeof useRunTargets>;
}

/** The preview this workspace opened last (a convenience; may be unset). */
function storageKey(workspaceId: string) {
	return `ade:open-localhost:${workspaceId}`;
}

function remembered(workspaceId: string): string | undefined {
	try {
		return localStorage.getItem(storageKey(workspaceId)) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * "Open localhost" beside Run: this workspace's browser-capable run targets
 * (its own project and folder only), opened through the run manager ADE
 * already has. No model is involved.
 */
export function OpenLocalhostButton({
	workspaceId,
	runs,
}: OpenLocalhostButtonProps) {
	const [selectedId, setSelectedId] = useState(() => remembered(workspaceId));
	const openInBrowserPane = useTabsStore((s) => s.openInBrowserPane);
	const open = electronTrpc.runTargets.openInBrowser.useMutation({
		onSuccess: (result) => {
			if (!result) return;
			if (result.status === "opened") {
				toast.success(`Opened ${result.url}`);
			} else if (result.status === "stopped") {
				toast(result.message);
			} else {
				toast.error(result.message, {
					description: result.logTail.slice(-3).join("\n") || undefined,
				});
			}
			void runs.refresh();
		},
		onError: (error) => toast.error(error.message),
	});

	const targets = runs.data?.targets ?? [];
	const candidates: PreviewCandidate[] = targets
		.filter((t) => t.preview.kind !== "none")
		.map((t) => ({
			id: t.target.id,
			name: t.target.name,
			label: "label" in t.preview ? t.preview.label : "",
			url: t.run?.url ?? undefined,
			status:
				t.run?.status === "ready"
					? "ready"
					: t.run?.status === "starting" ||
							t.run?.status === "running" ||
							t.run?.status === "stopping"
						? t.run.status === "stopping"
							? "stopped"
							: t.run.status
						: "stopped",
		}));
	const unsupported = targets.find((t) => t.preview.kind === "none");
	const preferred =
		candidates.find((c) => c.id === selectedId) ??
		candidates.find((c) => c.status === "ready") ??
		candidates[0];

	return (
		<OpenLocalhostView
			candidates={candidates}
			unsupportedReason={
				unsupported && "reason" in unsupported.preview
					? unsupported.preview.reason
					: null
			}
			selectedId={preferred?.id}
			busy={open.isPending}
			onOpen={(start) => {
				if (!preferred) return;
				open.mutate({ workspaceId, targetId: preferred.id, start });
			}}
			onSelect={(id) => {
				setSelectedId(id);
				try {
					localStorage.setItem(storageKey(workspaceId), id);
				} catch {
					// Not remembered: the choice still applies now.
				}
			}}
			onOpenInPane={(url) => openInBrowserPane(workspaceId, url)}
		/>
	);
}
