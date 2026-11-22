import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface ProjectTypeDialogProps {
	projectId: string;
	teamName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Choose or change a team's project type. ADE suggests one from the
 * repository's files (it reads metadata; it never runs the project).
 * Changing the type changes defaults only: agents, roles, tasks,
 * attachments and history stay as they are.
 */
export function ProjectTypeDialog({
	projectId,
	teamName,
	open,
	onOpenChange,
}: ProjectTypeDialogProps) {
	const utils = electronTrpc.useUtils();
	const { data: types = [] } = electronTrpc.projectConfig.types.useQuery(
		undefined,
		{ enabled: open },
	);
	const { data } = electronTrpc.projectConfig.get.useQuery(
		{ projectId },
		{ enabled: open },
	);
	const [chosen, setChosen] = useState<string>("");
	useEffect(() => {
		if (open && data) setChosen(data.config.type ?? data.detection.type);
	}, [open, data]);
	const save = electronTrpc.projectConfig.setType.useMutation({
		onSuccess: () => {
			toast.success("Project type saved");
			void utils.projectConfig.invalidate();
			onOpenChange(false);
		},
		onError: (error) => toast.error(error.message),
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="sm:max-w-[640px]"
				data-project-type-dialog
				onFocusOutside={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>Project type · {teamName}</DialogTitle>
					<DialogDescription>
						{data
							? `Detected: ${data.detection.framework}${
									data.detection.evidence.length
										? ` (from ${data.detection.evidence.slice(0, 3).join(", ")})`
										: ""
								}. Changing the type keeps agents, tasks and history.`
							: "Reading the repository's files…"}
					</DialogDescription>
				</DialogHeader>
				<div className="grid grid-cols-2 gap-2">
					{types.map((t) => (
						<button
							key={t.id}
							type="button"
							aria-pressed={chosen === t.id}
							onClick={() => setChosen(t.id)}
							className={cn(
								"space-y-0.5 rounded-lg border p-2.5 text-left transition-colors hover:bg-muted/40",
								chosen === t.id && "border-primary bg-primary/5",
							)}
							data-type={t.id}
						>
							<span className="flex items-center justify-between gap-2 text-sm font-semibold">
								{t.name}
								{data?.detection.type === t.id && (
									<span className="text-[11px] font-normal text-muted-foreground">
										detected
									</span>
								)}
							</span>
							<span className="block text-xs text-muted-foreground">
								{t.description}
							</span>
						</button>
					))}
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						disabled={!chosen || save.isPending}
						onClick={() =>
							save.mutate({
								projectId,
								type: chosen as Parameters<typeof save.mutate>[0]["type"],
							})
						}
					>
						Save type
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
