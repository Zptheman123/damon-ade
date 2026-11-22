import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import {
	TbCamera,
	TbClock,
	TbCopy,
	TbDots,
	TbPaperclip,
	TbReload,
	TbTrash,
} from "react-icons/tb";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useComposerAttachments } from "renderer/screens/main/components/WorkspaceView/shared/composer/useComposerAttachments";
import { useTabsStore } from "renderer/stores/tabs/store";
import { VIEWPORT_PRESETS } from "../../../../constants";

interface BrowserOverflowMenuProps {
	paneId: string;
	/** Whether a real page is loaded (not about:blank) */
	hasPage: boolean;
}

export function BrowserOverflowMenu({
	paneId,
	hasPage,
}: BrowserOverflowMenuProps) {
	const screenshotMutation = electronTrpc.browser.screenshot.useMutation();
	const reloadMutation = electronTrpc.browser.reload.useMutation();
	const clearBrowsingDataMutation =
		electronTrpc.browser.clearBrowsingData.useMutation();
	const clearHistoryMutation = electronTrpc.browserHistory.clear.useMutation();
	const currentUrl = useTabsStore((s) => s.panes[paneId]?.browser?.currentUrl);
	const viewport = useTabsStore((s) => s.panes[paneId]?.browser?.viewport);
	const setBrowserViewport = useTabsStore((s) => s.setBrowserViewport);
	const workspaceId = useTabsStore((s) => {
		const tabId = s.panes[paneId]?.tabId;
		return s.tabs.find((t) => t.id === tabId)?.workspaceId ?? "";
	});
	const taskDraft = useComposerAttachments(workspaceId, "tasks");

	/** A screenshot of the page, added to the Tasks message being written. */
	const handleAttachScreenshot = async () => {
		try {
			const { base64 } = await screenshotMutation.mutateAsync({ paneId });
			let host = "page";
			try {
				host = new URL(currentUrl ?? "").host.replace(/[^\w.-]+/g, "-");
			} catch {}
			await taskDraft.addImage(
				`preview-${host}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
				base64,
			);
			toast.success("Screenshot attached to the Tasks message");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not take a screenshot",
			);
		}
	};

	const handleScreenshot = () => {
		screenshotMutation.mutate({ paneId });
	};

	const handleHardReload = () => {
		reloadMutation.mutate({ paneId, hard: true });
	};

	const handleCopyUrl = () => {
		if (currentUrl) {
			navigator.clipboard.writeText(currentUrl);
		}
	};

	const handleClearCookies = () => {
		clearBrowsingDataMutation.mutate({ type: "cookies" });
	};

	const handleClearHistory = () => {
		clearHistoryMutation.mutate();
	};

	const handleClearAllData = () => {
		clearBrowsingDataMutation.mutate({ type: "all" });
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
				>
					<TbDots className="size-3.5" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				<DropdownMenuItem
					onClick={handleScreenshot}
					disabled={!hasPage}
					className="gap-2"
				>
					<TbCamera className="size-4" />
					Take Screenshot
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => void handleAttachScreenshot()}
					disabled={!hasPage || !workspaceId}
					className="gap-2"
				>
					<TbPaperclip className="size-4" />
					Attach Screenshot to Tasks
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={handleHardReload}
					disabled={!hasPage}
					className="gap-2"
				>
					<TbReload className="size-4" />
					Hard Reload
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={handleCopyUrl}
					disabled={!hasPage}
					className="gap-2"
				>
					<TbCopy className="size-4" />
					Copy URL
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
					Screen size
				</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={viewport?.name ?? "fit"}
					onValueChange={(value) =>
						setBrowserViewport(
							paneId,
							VIEWPORT_PRESETS.find((p) => p.name === value) ?? null,
						)
					}
				>
					<DropdownMenuRadioItem value="fit">
						Fit the pane
					</DropdownMenuRadioItem>
					{VIEWPORT_PRESETS.map((preset) => (
						<DropdownMenuRadioItem key={preset.name} value={preset.name}>
							{preset.name} · {preset.width}×{preset.height}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={handleClearHistory} className="gap-2">
					<TbClock className="size-4" />
					Clear Browsing History
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleClearCookies} className="gap-2">
					<TbTrash className="size-4" />
					Clear Cookies
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleClearAllData} className="gap-2">
					<TbTrash className="size-4" />
					Clear All Data
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
