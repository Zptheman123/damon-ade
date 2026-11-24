import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useState } from "react";
import { LuFlagTriangleRight, LuOctagonX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { INTERRUPT, SUBMIT_DELAY_MS, WRAP_UP_MESSAGE } from "./constants";
import { agentPanes } from "./utils/agentPanes";

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/**
 * Two controls for the whole team: Wrap up (each agent finishes the step
 * it is on, saves and stops) and Stop all (everything stops now). ADE's
 * tasks pause, so Resume continues them; Claude sessions open in the
 * team's terminals get the same request.
 */
export function TeamControls({ workspaceId }: { workspaceId: string }) {
	const [confirmStop, setConfirmStop] = useState(false);
	const utils = electronTrpc.useUtils();
	const write = electronTrpc.terminal.write.useMutation();
	const wrapUp = electronTrpc.workflow.wrapUpAll.useMutation();
	const stopAll = electronTrpc.workflow.stopAll.useMutation();
	const busy = wrapUp.isPending || stopAll.isPending;

	/** Send to each pane; returns how many took it. */
	const sendToPanes = async (
		paneIds: string[],
		data: string,
		enter: boolean,
	) => {
		const sent = await Promise.all(
			paneIds.map(async (paneId) => {
				try {
					await write.mutateAsync({ paneId, data });
					if (enter) {
						await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
						await write.mutateAsync({ paneId, data: "\r" });
					}
					return true;
				} catch {
					return false;
				}
			}),
		);
		return sent.filter(Boolean).length;
	};

	const sessionsOf = (workspaceIds: string[], stop: boolean) =>
		agentPanes(
			useTabsStore.getState(),
			workspaceIds,
			// A session asking for permission is not typed into (the text would
			// answer the prompt); Stop interrupts it like the others.
			stop ? ["working", "permission"] : ["working"],
		);

	const report = (tasks: number, sessions: number, what: string) => {
		void utils.workflow.invalidate();
		if (tasks === 0 && sessions === 0) {
			toast.info("Nothing is working right now.");
			return;
		}
		toast.success(
			[
				tasks ? plural(tasks, "task") : "",
				sessions ? plural(sessions, "Claude session") : "",
			]
				.filter(Boolean)
				.join(" and ") + what,
		);
	};

	const handleWrapUp = async () => {
		try {
			const result = await wrapUp.mutateAsync({ workspaceId });
			const sessions = await sendToPanes(
				sessionsOf(result.workspaceIds, false),
				WRAP_UP_MESSAGE,
				true,
			);
			report(
				result.tasks,
				sessions,
				` told to wrap up. Tasks finish the step they are on, then pause; Resume continues them.`,
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};

	const handleStop = async () => {
		setConfirmStop(false);
		try {
			const result = await stopAll.mutateAsync({ workspaceId });
			const sessions = await sendToPanes(
				sessionsOf(result.workspaceIds, true),
				INTERRUPT,
				false,
			);
			report(
				result.tasks,
				sessions,
				" stopped. Their work so far is kept; Resume continues them.",
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						disabled={busy}
						onClick={handleWrapUp}
						className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
					>
						<LuFlagTriangleRight className="size-3.5" aria-hidden />
						Wrap up
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" showArrow={false}>
					Every agent finishes the step it is on, saves its work and stops.
					Resume continues
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						disabled={busy}
						onClick={() => setConfirmStop(true)}
						className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40 dark:hover:text-red-400"
					>
						<LuOctagonX className="size-3.5" aria-hidden />
						Stop all
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" showArrow={false}>
					Stop every agent now, mid-step. Their work so far is kept
				</TooltipContent>
			</Tooltip>

			<AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
				<AlertDialogContent className="max-w-[360px] gap-0 p-0">
					<AlertDialogHeader className="px-4 pt-4 pb-2">
						<AlertDialogTitle className="font-medium">
							Stop every agent now?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Every task of this team stops mid-step and pauses, and each Claude
							session working in its terminals is interrupted. What they wrote
							so far stays in their folders; the step they were on runs again
							when you Resume.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter className="flex-row justify-end gap-2 px-4 pt-2 pb-4">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-3 text-xs"
							onClick={() => setConfirmStop(false)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							size="sm"
							className="h-7 px-3 text-xs"
							onClick={handleStop}
						>
							Stop all
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
