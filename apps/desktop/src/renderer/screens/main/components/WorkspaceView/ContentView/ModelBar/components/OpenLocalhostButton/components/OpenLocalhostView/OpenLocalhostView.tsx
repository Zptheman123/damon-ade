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
import {
	LuChevronDown,
	LuExternalLink,
	LuLoaderCircle,
	LuPanelRight,
	LuPlay,
} from "react-icons/lu";

export interface PreviewCandidate {
	id: string;
	name: string;
	/** What it opens: "Local preview", "Renderer preview (...)", ... */
	label: string;
	status: "ready" | "starting" | "running" | "stopped";
	url?: string;
}

interface OpenLocalhostViewProps {
	candidates: PreviewCandidate[];
	/** Why nothing can be opened in a browser (shown disabled), if so. */
	unsupportedReason?: string | null;
	selectedId?: string;
	busy?: boolean;
	onOpen: (start: boolean) => void;
	onSelect: (id: string) => void;
	onOpenInPane: (url: string) => void;
}

const BUTTON =
	"flex h-7 items-center gap-1.5 px-2 text-xs transition-colors disabled:opacity-50";

/**
 * Beside Run: open the project's running preview in the browser, or run it
 * and open it. Several previews: choose one from the menu.
 */
export function OpenLocalhostView({
	candidates,
	unsupportedReason,
	selectedId,
	busy,
	onOpen,
	onSelect,
	onOpenInPane,
}: OpenLocalhostViewProps) {
	if (!candidates.length) {
		if (!unsupportedReason) return null;
		return (
			<button
				type="button"
				disabled
				aria-disabled
				title={unsupportedReason}
				aria-label={`Open localhost: unavailable. ${unsupportedReason}`}
				className={cn(BUTTON, "rounded-md text-muted-foreground")}
				data-open-localhost="unsupported"
			>
				<LuExternalLink className="size-3.5" aria-hidden />
				Open localhost
			</button>
		);
	}
	const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0];
	// "running": the process runs but has not answered yet (or the check
	// gave up); clicking explains why it is not ready.
	const starting = selected.status === "starting";
	const stopped = selected.status === "stopped";
	const ready = selected.status === "ready" && !!selected.url;
	const label = busy
		? stopped
			? "Starting…"
			: "Opening…"
		: starting
			? "Starting…"
			: stopped
				? "Run and open"
				: "Open localhost";
	const title = ready
		? `Open ${selected.url} (${selected.name}: ${selected.label}) in your browser`
		: stopped
			? `${selected.name} is stopped. Start its command, wait until it answers, then open it in your browser.`
			: starting
				? `${selected.name} is starting; it opens once it answers.`
				: `${selected.name} is running but has not answered at its address yet.`;

	return (
		<div
			className="flex items-center rounded-md border bg-background"
			data-open-localhost={selected.status}
		>
			<button
				type="button"
				className={cn(
					BUTTON,
					"rounded-l-md hover:bg-muted",
					ready ? "text-foreground" : "text-muted-foreground",
				)}
				disabled={busy || starting}
				title={title}
				aria-label={`${label}: ${selected.name}`}
				onClick={() => onOpen(stopped)}
			>
				{busy || starting ? (
					<LuLoaderCircle className="size-3.5 animate-spin" aria-hidden />
				) : stopped ? (
					<LuPlay className="size-3.5" aria-hidden />
				) : (
					<LuExternalLink className="size-3.5" aria-hidden />
				)}
				{label}
				<span
					className={cn(
						"size-1.5 rounded-full",
						ready
							? "bg-emerald-500"
							: stopped
								? "bg-muted-foreground/40"
								: "bg-amber-500",
					)}
					aria-hidden
				/>
				<span className="sr-only">
					{ready ? "ready" : stopped ? "stopped" : "starting"}
				</span>
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="flex h-7 items-center rounded-r-md border-l px-1 text-muted-foreground hover:bg-muted"
						aria-label="Choose the preview to open"
					>
						<LuChevronDown className="size-3" aria-hidden />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-72">
					<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
						Preview to open
					</DropdownMenuLabel>
					<DropdownMenuRadioGroup value={selected.id} onValueChange={onSelect}>
						{candidates.map((c) => (
							<DropdownMenuRadioItem
								key={c.id}
								value={c.id}
								className="text-xs"
							>
								<span className="min-w-0">
									<span className="block truncate">{c.name}</span>
									<span className="block truncate text-[11px] text-muted-foreground">
										{c.label} ·{" "}
										{c.status === "ready" && c.url ? c.url : c.status}
									</span>
								</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
					{ready && selected.url && (
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
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
