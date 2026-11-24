import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { useRunTargets } from "../../hooks/useRunTargets";
import { DeviceDialog } from "./components/DeviceDialog";
import {
	type PreviewApp,
	type PreviewCandidate,
	PreviewView,
} from "./components/PreviewView";
import { terminalQr } from "./utils/terminalQr";

interface PreviewButtonProps {
	workspaceId: string;
	runs: ReturnType<typeof useRunTargets>;
}

type Listed = NonNullable<
	ReturnType<typeof useRunTargets>["data"]
>["targets"][number];

interface DeviceView {
	name: string;
	deviceUrl: string;
	url?: string;
	qr?: string[];
}

/** The app this workspace previewed last (a convenience; may be unset). */
function storageKey(workspaceId: string) {
	return `ade:preview:${workspaceId}`;
}

function remembered(workspaceId: string): string | undefined {
	try {
		return localStorage.getItem(storageKey(workspaceId)) ?? undefined;
	} catch {
		return undefined;
	}
}

function appOf(item: Pick<Listed, "target" | "preview">): PreviewApp | null {
	if (item.target.kind === "desktop") return "desktop";
	if (item.target.kind === "mobile") return "mobile";
	return item.preview.kind === "none" ? null : "web";
}

const APP_LABEL: Record<Exclude<PreviewApp, "web">, string> = {
	desktop: "Opens in its own window",
	mobile: "On your phone (Expo Go)",
};

function candidate(item: Listed): PreviewCandidate | null {
	const app = appOf(item);
	if (!app) return null;
	const run = item.run;
	const status: PreviewCandidate["status"] =
		run?.status === "ready"
			? "ready"
			: run?.status === "starting" || run?.status === "running"
				? run.status
				: "stopped";
	return {
		id: item.target.id,
		name: item.target.name,
		app,
		label:
			app === "web"
				? "label" in item.preview
					? item.preview.label
					: "Local preview"
				: APP_LABEL[app],
		status,
		url: run?.url ?? undefined,
		deviceUrl: run?.deviceUrl ?? undefined,
	};
}

/**
 * "Preview" beside Run: one click shows the team's app, whether it is a
 * web app (the browser), a desktop app (its window) or a mobile app (a QR
 * code for the phone). Works before anything is set up: a target ADE
 * detected is saved the first time it is previewed. No model is involved.
 */
export function PreviewButton({ workspaceId, runs }: PreviewButtonProps) {
	const [selectedId, setSelectedId] = useState(() => remembered(workspaceId));
	const [device, setDevice] = useState<DeviceView | null>(null);
	const openInBrowserPane = useTabsStore((s) => s.openInBrowserPane);
	const utils = electronTrpc.useUtils();

	const items: Listed[] = [
		...(runs.data?.targets ?? []),
		...(runs.data?.suggestedPreviews ?? []).map((s) => ({ ...s, run: null })),
	];
	const candidates = items
		.map(candidate)
		.filter((c): c is PreviewCandidate => !!c);
	const unsupported = items.find((t) => !appOf(t));
	const preferred =
		candidates.find((c) => c.id === selectedId) ??
		candidates.find((c) => c.status !== "stopped") ??
		candidates[0];

	const showDevice = async (view: DeviceView, targetId: string) => {
		let qr: string[] | undefined;
		try {
			qr = terminalQr(
				await utils.runTargets.logs.fetch({ workspaceId, targetId }),
			);
		} catch {
			// The address alone still works.
		}
		setDevice({ ...view, qr });
	};

	const preview = electronTrpc.runTargets.preview.useMutation({
		onSuccess: async (result, input) => {
			void runs.refresh();
			if (!result) return;
			switch (result.status) {
				case "opened":
					toast.success(`Opened ${result.url}`);
					return;
				case "launched":
					toast.success(result.message);
					return;
				case "stopped":
					toast(result.message);
					return;
				case "device":
					await showDevice(
						{
							name:
								candidates.find((c) => c.id === input.targetId)?.name ??
								"the app",
							deviceUrl: result.deviceUrl,
							url: result.url,
						},
						input.targetId,
					);
					return;
				default:
					toast.error(result.message, {
						description: result.logTail.slice(-3).join("\n") || undefined,
					});
			}
		},
		onError: (error) => toast.error(error.message),
	});

	return (
		<>
			<PreviewView
				candidates={candidates}
				unsupportedReason={
					unsupported && "reason" in unsupported.preview
						? unsupported.preview.reason
						: null
				}
				selectedId={preferred?.id}
				busy={preview.isPending}
				onOpen={() => {
					if (!preferred) return;
					preview.mutate({ workspaceId, targetId: preferred.id, start: true });
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
				onShowDevice={() => {
					if (!preferred?.deviceUrl) return;
					void showDevice(
						{
							name: preferred.name,
							deviceUrl: preferred.deviceUrl,
							url: preferred.url,
						},
						preferred.id,
					);
				}}
			/>
			{device && (
				<DeviceDialog
					open
					onOpenChange={(open) => !open && setDevice(null)}
					{...device}
					onCopy={(text) => {
						void navigator.clipboard.writeText(text);
						toast.success("Copied");
					}}
					onOpenWeb={(url) => {
						setDevice(null);
						openInBrowserPane(workspaceId, url);
					}}
				/>
			)}
		</>
	);
}
