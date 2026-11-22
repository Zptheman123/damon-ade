import { Button } from "@superset/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@superset/ui/sheet";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { LuPlus, LuSparkles } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { useRunTargets } from "../../hooks/useRunTargets";
import { RequestPanel } from "./components/RequestPanel";
import { RunTargetCard } from "./components/RunTargetCard";
import { TargetEditor } from "./components/TargetEditor";
import { TYPE_HINTS } from "./constants";
import type { TargetView } from "./types";

interface RunSheetProps {
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	runs: ReturnType<typeof useRunTargets>;
}

const onError = (err: { message: string }) => toast.error(err.message);

/**
 * Run: the team's dev servers, apps, games and commands for this
 * workspace. Detected targets are suggestions until added; nothing starts
 * until the user presses Start. Web targets open in a preview tab or the
 * system browser; backends get a request panel.
 */
export function RunSheet({
	workspaceId,
	open,
	onOpenChange,
	runs,
}: RunSheetProps) {
	const { data, error, logs, watchLogs, unwatchLogs, refresh } = runs;
	const openInBrowserPane = useTabsStore((s) => s.openInBrowserPane);
	const [editing, setEditing] = useState<TargetView | "new" | null>(null);
	const handlers = { onError, onSuccess: () => void refresh() };
	const start = electronTrpc.runTargets.start.useMutation(handlers);
	const stop = electronTrpc.runTargets.stop.useMutation(handlers);
	const restart = electronTrpc.runTargets.restart.useMutation(handlers);
	const saveTarget = electronTrpc.projectConfig.saveTarget.useMutation({
		onError,
		onSuccess: () => {
			setEditing(null);
			void refresh();
		},
	});
	const removeTarget =
		electronTrpc.projectConfig.removeTarget.useMutation(handlers);
	const openUrl = electronTrpc.external.openUrl.useMutation({ onError });
	const busy =
		start.isPending ||
		stop.isPending ||
		restart.isPending ||
		saveTarget.isPending ||
		removeTarget.isPending;

	const type = data?.type ?? null;
	const showRequests =
		type === "backend-api" ||
		!!data?.targets.some((t) => t.target.kind === "service");
	const serverUrl = data?.targets.find(
		(t) =>
			t.run?.url &&
			(t.run.status === "ready" || t.run.status === "running") &&
			(t.target.kind === "service" || t.target.kind === "web"),
	)?.run?.url;

	const save = (target: TargetView) =>
		saveTarget.mutate({ workspaceId, target });

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-[540px] overflow-y-auto sm:max-w-[540px]">
				<SheetHeader>
					<SheetTitle>
						Run
						{data?.typeName ? ` · ${data.typeName}` : ""}
						{data?.framework ? ` · ${data.framework}` : ""}
					</SheetTitle>
					<SheetDescription>
						{type
							? TYPE_HINTS[type]
							: "Set the team's project type (right-click the team) for tailored targets. You can still add commands here."}
					</SheetDescription>
				</SheetHeader>

				<div className="space-y-3 px-4 pb-6">
					{error && <p className="text-sm text-destructive">{error}</p>}

					{data?.targets.map(({ target, run }) =>
						editing !== "new" && editing?.id === target.id ? (
							<TargetEditor
								key={target.id}
								initial={target}
								onSave={save}
								onCancel={() => setEditing(null)}
								busy={busy}
							/>
						) : (
							<RunTargetCard
								key={target.id}
								target={target}
								run={run}
								projectType={type}
								logs={logs[target.id]}
								busy={busy}
								onStart={() =>
									start.mutate({ workspaceId, targetId: target.id })
								}
								onStop={() => stop.mutate({ workspaceId, targetId: target.id })}
								onRestart={() =>
									restart.mutate({ workspaceId, targetId: target.id })
								}
								onOpenPreview={(url) => {
									openInBrowserPane(workspaceId, url);
									onOpenChange(false);
								}}
								onOpenExternal={(url) => openUrl.mutate(url)}
								onToggleLogs={() =>
									target.id in logs
										? unwatchLogs(target.id)
										: void watchLogs(target.id)
								}
								onEdit={() => setEditing(target)}
								onRemove={() =>
									removeTarget.mutate({ workspaceId, id: target.id })
								}
								onSaveArgs={(args) => save({ ...target, args })}
								onCopy={(text) => {
									void navigator.clipboard.writeText(text);
									toast.success("Copied");
								}}
							/>
						),
					)}

					{data &&
						!data.targets.length &&
						!data.suggested.length &&
						editing !== "new" && (
							<p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
								No run targets yet. Add the command you use to start this
								project.
							</p>
						)}

					{!!data?.suggested.length && (
						<section className="space-y-1.5" data-run-suggestions>
							<h3 className="flex items-center gap-1.5 text-xs font-medium">
								<LuSparkles
									className="size-3.5 text-muted-foreground"
									aria-hidden
								/>
								Found in the repository
							</h3>
							<p className="text-[11px] text-muted-foreground">
								Read from the project's files; nothing has been run. Add one to
								be able to start it.
							</p>
							{data.suggested.map((s) => (
								<div
									key={s.id}
									className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2"
								>
									<div className="min-w-0 flex-1">
										<div className="text-xs font-medium">{s.name}</div>
										<code className="block truncate font-mono text-[11px] text-muted-foreground">
											{s.command}
											{s.cwd && s.cwd !== "." ? `  · in ${s.cwd}` : ""}
										</code>
										{s.prerequisite && (
											<div className="text-[11px] text-muted-foreground">
												Needs: {s.prerequisite}
											</div>
										)}
									</div>
									<Button
										size="sm"
										variant="outline"
										className="h-7 text-xs"
										disabled={busy}
										onClick={() => save(s)}
									>
										Add
									</Button>
								</div>
							))}
						</section>
					)}

					{editing === "new" ? (
						<TargetEditor
							onSave={save}
							onCancel={() => setEditing(null)}
							busy={busy}
						/>
					) : (
						<Button
							variant="ghost"
							size="sm"
							className="h-8 gap-1.5 text-xs"
							onClick={() => setEditing("new")}
						>
							<LuPlus className="size-3.5" aria-hidden />
							Add a target
						</Button>
					)}

					{showRequests && (
						<div className="border-t pt-3">
							<RequestPanel baseUrl={serverUrl} />
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
