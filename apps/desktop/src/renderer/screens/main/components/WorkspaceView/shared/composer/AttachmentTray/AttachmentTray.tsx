import { cn } from "@superset/ui/utils";
import {
	LuCircleAlert,
	LuFile,
	LuFileCode,
	LuFileText,
	LuLoaderCircle,
	LuSheet,
	LuX,
} from "react-icons/lu";
import type { DraftAttachment } from "renderer/stores/composer-drafts";

interface AttachmentTrayProps {
	items: DraftAttachment[];
	onRemove: (key: string) => void;
	className?: string;
}

function size(bytes: number): string {
	return bytes < 1024 * 1024
		? `${Math.max(1, Math.round(bytes / 1024))} KB`
		: `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_ICON = {
	pdf: LuFileText,
	text: LuFileText,
	code: LuFileCode,
	data: LuSheet,
};

/**
 * The files attached to a draft: a preview, name, type and size, whether
 * the model can read it (hover), and remove. Adding and failed states are
 * shown in place.
 */
export function AttachmentTray({
	items,
	onRemove,
	className,
}: AttachmentTrayProps) {
	if (!items.length) return null;
	return (
		<ul
			className={cn("flex flex-wrap gap-1.5", className)}
			data-attachment-tray
		>
			{items.map((item) => {
				const a = item.attachment;
				const Icon = a
					? (KIND_ICON[a.kind as keyof typeof KIND_ICON] ?? LuFile)
					: LuFile;
				return (
					<li
						key={item.key}
						className={cn(
							"flex max-w-[240px] items-center gap-2 rounded-md border bg-background py-1 pl-1 pr-1.5 text-xs",
							item.status === "error" &&
								"border-destructive/50 bg-destructive/5",
						)}
						title={item.error ?? a?.access ?? "Adding…"}
						data-attachment={item.status}
					>
						<span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
							{item.status === "adding" ? (
								<LuLoaderCircle
									className="size-4 animate-spin text-muted-foreground"
									aria-hidden
								/>
							) : item.status === "error" ? (
								<LuCircleAlert
									className="size-4 text-destructive"
									aria-hidden
								/>
							) : a?.kind === "image" && a.preview ? (
								<img
									src={a.preview}
									alt=""
									className="size-full object-cover"
								/>
							) : (
								<Icon className="size-4 text-muted-foreground" aria-hidden />
							)}
						</span>
						<span className="min-w-0">
							<span className="block truncate font-medium">{item.name}</span>
							<span
								className={cn(
									"block truncate text-[11px]",
									item.status === "error"
										? "text-destructive"
										: "text-muted-foreground",
								)}
							>
								{item.status === "adding"
									? "Adding…"
									: item.status === "error"
										? item.error
										: `${a?.kind} · ${size(a?.size ?? 0)} · readable`}
							</span>
						</span>
						<button
							type="button"
							aria-label={`Remove ${item.name}`}
							onClick={() => onRemove(item.key)}
							className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
						>
							<LuX className="size-3.5" aria-hidden />
						</button>
					</li>
				);
			})}
		</ul>
	);
}
