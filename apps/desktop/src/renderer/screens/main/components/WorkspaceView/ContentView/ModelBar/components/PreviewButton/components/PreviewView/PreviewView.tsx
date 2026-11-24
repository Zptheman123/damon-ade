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
import { cn } from "@superset/ui/utils";
import type { IconType } from "react-icons";
import {
	LuChevronDown,
	LuGlobe,
	LuLoaderCircle,
	LuMonitor,
	LuPanelRight,
	LuSmartphone,
} from "react-icons/lu";

export type PreviewApp = "web" | "desktop" | "mobile";

export interface PreviewCandidate {
	id: string;
	name: string;
	/** What it shows as: the web app, the desktop app's window, a phone. */
	app: PreviewApp;
	/** "Local preview", "Web game", ... */
	label: string;
	status: "ready" | "starting" | "running" | "stopped";
	url?: string;
	/** A mobile app's address for a phone (exp://…). */
	deviceUrl?: string;
}

interface PreviewViewProps {
	candidates: PreviewCandidate[];
	/** Why nothing can be previewed (shown disabled), if so. */
	unsupportedReason?: string | null;
	selectedId?: string;
	busy?: boolean;
	onOpen: () => void;
	onSelect: (id: string) => void;
	onOpenInPane: (url: string) => void;
	onShowDevice: () => void;
}

const BUTTON =
	"flex h-7 items-center gap-1.5 px-2 text-xs transition-colors disabled:opacity-50";

export const APP_ICON: Record<PreviewApp, IconType> = {
	web: LuGlobe,
	desktop: LuMonitor,
	mobile: LuSmartphone,
};

const OPEN_LABEL: Record<PreviewApp, string> = {
	web: "Open web app",
	desktop: "Open desktop app",
	mobile: "Open on phone",
};

function describe(c: PreviewCandidate): string {
	const running = c.status !== "stopped";
	switch (c.app) {
		case "web":
			return c.status === "ready" && c.url
				? `Open ${c.url} (${c.name}) in your browser`
				: running
					? `${c.name} is starting; it opens in your browser once it answers.`
					: `Start ${c.name}, wait until it answers, then open it in your browser.`;
		case "desktop":
			return running
				? `${c.name} is running in its own window.`
				: `Start ${c.name}; it opens in its own window.`;
		case "mobile":
			return c.deviceUrl
				? `Show the address and QR code to open ${c.name} on your phone`
				: running
					? `${c.name} is starting; its phone address appears once it is ready.`
					: `Start ${c.name} and show the QR code to open it on your phone (Expo Go).`;
	}
}

/**
 * Beside Run: one click shows the project's app. A web app opens in the
 * browser, a desktop app in its own window, a mobile app on a phone (its
 * address and QR code). Several apps: choose one from the menu.
 */
export function PreviewView({
	candidates,
	unsupportedReason,
	selectedId,
	busy,
	onOpen,
	onSelect,
	onOpenInPane,
	onShowDevice,
}: PreviewViewProps) {
	if (!candidates.length) {
		if (!unsupportedReason) return null;
		return (
			<button
				type="button"
				disabled
				aria-disabled
				title={unsupportedReason}
				aria-label={`Preview: unavailable. ${unsupportedReason}`}
				className={cn(BUTTON, "rounded-md text-muted-foreground")}
				data-preview="unsupported"
			>
				<LuGlobe className="size-3.5" aria-hidden />
				Preview
			</button>
		);
	}
	const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0];
	const Icon = APP_ICON[selected.app];
	const stopped = selected.status === "stopped";
	// A web app opens once it answers: no second click while it starts.
	const waiting = selected.app === "web" && selected.status === "starting";
	const live =
		selected.app === "web"
			? selected.status === "ready" && !!selected.url
			: !stopped;
	const label = busy
		? stopped
			? "Starting…"
			: "Opening…"
		: waiting
			? "Starting…"
			: OPEN_LABEL[selected.app];

	return (
		<div
			className="flex items-center rounded-md border bg-background"
			data-preview={selected.status}
			data-preview-app={selected.app}
		>
			<button
				type="button"
				className={cn(
					BUTTON,
					"rounded-l-md hover:bg-muted",
					live ? "text-foreground" : "text-muted-foreground",
				)}
				disabled={busy || waiting}
				title={describe(selected)}
				aria-label={`${label}: ${selected.name}`}
				onClick={onOpen}
			>
				{busy || waiting ? (
					<LuLoaderCircle className="size-3.5 animate-spin" aria-hidden />
				) : (
					<Icon className="size-3.5" aria-hidden />
				)}
				{label}
				<span
					className={cn(
						"size-1.5 rounded-full",
						live
							? "bg-emerald-500"
							: stopped
								? "bg-muted-foreground/40"
								: "bg-amber-500",
					)}
					aria-hidden
				/>
				<span className="sr-only">
					{live ? "running" : stopped ? "stopped" : "starting"}
				</span>
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="flex h-7 items-center rounded-r-md border-l px-1 text-muted-foreground hover:bg-muted"
						aria-label="Choose the app to preview"
					>
						<LuChevronDown className="size-3" aria-hidden />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-72">
					<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
						App to preview
					</DropdownMenuLabel>
					<DropdownMenuRadioGroup value={selected.id} onValueChange={onSelect}>
						{candidates.map((c) => {
							const ItemIcon = APP_ICON[c.app];
							return (
								<DropdownMenuRadioItem
									key={c.id}
									value={c.id}
									className="text-xs"
								>
									<ItemIcon
										className="size-3.5 shrink-0 text-muted-foreground"
										aria-hidden
									/>
									<span className="min-w-0">
										<span className="block truncate">{c.name}</span>
										<span className="block truncate text-[11px] text-muted-foreground">
											{c.label} ·{" "}
											{c.app === "web" && c.status === "ready" && c.url
												? c.url
												: c.status === "ready"
													? "running"
													: c.status}
										</span>
									</span>
								</DropdownMenuRadioItem>
							);
						})}
					</DropdownMenuRadioGroup>
					{selected.app === "web" && live && selected.url && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="gap-2 text-xs"
								onClick={() => onOpenInPane(selected.url as string)}
							>
								<LuPanelRight className="size-3.5" aria-hidden />
								Open in ADE's preview tab instead
							</DropdownMenuItem>
						</>
					)}
					{selected.app === "mobile" && selected.deviceUrl && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="gap-2 text-xs"
								onClick={onShowDevice}
							>
								<LuSmartphone className="size-3.5" aria-hidden />
								Show the QR code for your phone
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
