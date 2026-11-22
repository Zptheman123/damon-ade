import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@superset/ui/sheet";
import { toast } from "@superset/ui/sonner";
import { useDeferredValue, useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { AttachmentTray } from "renderer/screens/main/components/WorkspaceView/shared/composer/AttachmentTray";
import { ComposerTools } from "renderer/screens/main/components/WorkspaceView/shared/composer/ComposerTools";
import { useComposerAttachments } from "renderer/screens/main/components/WorkspaceView/shared/composer/useComposerAttachments";
import { useVoiceDictation } from "renderer/screens/main/components/WorkspaceView/shared/composer/useVoiceDictation";
import { useLaunchInNewTab } from "../../hooks/useLaunchInNewTab";
import { TasksPanelView } from "./components/TasksPanelView";
import type { TaskActions } from "./types";

/**
 * The Tasks panel of a workspace: the container. It reads the project's
 * tasks, refreshes when ADE reports a change, and sends every action to the
 * workflow router, where the TaskController runs the stages. Nothing here
 * decides a transition.
 */

interface TasksSheetProps {
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const onError = (err: { message: string }) => toast.error(err.message);

interface StateResult {
	state?: string;
	stateReason?: string | null;
}

export function TasksSheet({
	workspaceId,
	open,
	onOpenChange,
}: TasksSheetProps) {
	const utils = electronTrpc.useUtils();
	const launchInNewTab = useLaunchInNewTab();
	const [description, setDescription] = useState("");
	const deferredDescription = useDeferredValue(description.trim());

	const { data, error } = electronTrpc.workflow.getProjectTasks.useQuery(
		{ workspaceId },
		{
			enabled: open,
			// Change events refresh at once; polling is the fallback.
			refetchInterval: (query) =>
				open && query.state.data?.tasks.some((task) => task.state === "running")
					? 2000
					: open
						? 10_000
						: false,
		},
	);
	const { data: checks } = electronTrpc.workflow.getChecks.useQuery(
		{ workspaceId },
		{ enabled: open },
	);
	const { data: approvals } =
		electronTrpc.workflow.getCommandApprovals.useQuery(
			{ workspaceId },
			{ enabled: open },
		);
	const { data: preview } = electronTrpc.workflow.classify.useQuery(
		{ description: deferredDescription },
		{ enabled: open && deferredDescription.length > 0 },
	);

	electronTrpc.workflow.onTaskChanged.useSubscription(undefined, {
		enabled: open,
		onData: (event) => {
			if (!data || event.projectKey === data.project.key) {
				void utils.workflow.getProjectTasks.invalidate({ workspaceId });
			}
		},
	});

	const refresh = () => {
		void utils.workflow.getProjectTasks.invalidate({ workspaceId });
		void utils.workflow.getChecks.invalidate({ workspaceId });
		void utils.workflow.getCommandApprovals.invalidate({ workspaceId });
	};
	/** A launch that could not start comes back as a blocked task: say so. */
	const reportState = (result: StateResult) => {
		if (result.state === "blocked" || result.state === "failed") {
			toast.error(result.stateReason ?? "The task could not continue");
		}
		refresh();
	};
	const handlers = { onSuccess: reportState, onError };

	const attachments = useComposerAttachments(workspaceId, "tasks");
	const voice = useVoiceDictation((text) =>
		setDescription((current) =>
			current.trim() ? `${current.trimEnd()} ${text}` : text,
		),
	);
	const createTask = electronTrpc.workflow.createTask.useMutation({
		onSuccess: (result) => {
			setDescription("");
			attachments.clear();
			if (result.mode === "auto" && result.state === "running") {
				toast.success("Task started");
			}
			reportState(result);
		},
		onError,
	});
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const approveCommand = electronTrpc.workflow.approveCommand.useMutation({
		onSuccess: (approval) => {
			toast.success(`Approved: ${approval.rule}`);
			refresh();
		},
		onError,
	});
	const removeApproval =
		electronTrpc.workflow.removeCommandApproval.useMutation({
			onSuccess: refresh,
			onError,
		});
	const start = electronTrpc.workflow.start.useMutation(handlers);
	const resume = electronTrpc.workflow.resume.useMutation(handlers);
	const pause = electronTrpc.workflow.pause.useMutation(handlers);
	const cancel = electronTrpc.workflow.cancel.useMutation(handlers);
	const setMode = electronTrpc.workflow.setMode.useMutation(handlers);
	const answer = electronTrpc.workflow.answer.useMutation(handlers);
	const runStep = electronTrpc.workflow.runStep.useMutation(handlers);
	const moveHere = electronTrpc.workflow.moveHere.useMutation({
		onSuccess: refresh,
		onError,
	});
	const setBudget = electronTrpc.workflow.setBudget.useMutation({
		onSuccess: refresh,
		onError,
	});
	const refreshHistory = electronTrpc.workflow.refreshTaskHistory.useMutation({
		onSuccess: (result) => {
			toast.success(
				result.excerpts
					? `History refreshed: ${result.excerpts} excerpt(s)`
					: "No linked conversation matches this task",
			);
			refresh();
		},
		onError,
	});
	const excludeHistory = electronTrpc.workflow.excludeTaskHistory.useMutation({
		onSuccess: refresh,
		onError,
	});
	const clearHistory = electronTrpc.workflow.clearTaskHistory.useMutation({
		onSuccess: refresh,
		onError,
	});
	const setSpecialist = electronTrpc.workflow.setTaskSpecialist.useMutation({
		onSuccess: refresh,
		onError,
	});
	const { data: specialistList } = electronTrpc.specialists.list.useQuery(
		{ workspaceId },
		{ enabled: open },
	);
	const specialists = (specialistList?.specialists ?? []).map((s) => ({
		id: s.id,
		name: s.name,
		specialty: s.specialty,
	}));
	const setChecks = electronTrpc.workflow.setChecks.useMutation({
		onSuccess: (result) => {
			toast.success(
				result.commands.length
					? `${result.commands.length} check(s) approved`
					: "No checks: the review alone decides",
			);
			refresh();
		},
		onError,
	});

	const mutations = [
		createTask,
		start,
		resume,
		pause,
		cancel,
		setMode,
		answer,
		runStep,
		moveHere,
		setBudget,
		setChecks,
		refreshHistory,
		excludeHistory,
		clearHistory,
		setSpecialist,
		approveCommand,
		removeApproval,
	];
	const busy = mutations.some((mutation) => mutation.isPending);

	const actions: TaskActions = useMemo(
		() => ({
			busy,
			onDescriptionChange: setDescription,
			onCreate: (input) =>
				createTask.mutate({
					workspaceId,
					...input,
					attachments: attachments.ids,
				}),
			onOpenUrl: (url) => openUrl.mutate(url),
			onStart: (slug) => start.mutate({ workspaceId, slug }),
			onResume: (slug, options) =>
				resume.mutate({ workspaceId, slug, ...options }),
			onApproveCommand: (input) =>
				approveCommand.mutate({ workspaceId, ...input }),
			onRemoveApproval: (id) => removeApproval.mutate({ workspaceId, id }),
			onPause: (slug) => pause.mutate({ workspaceId, slug }),
			onCancel: (slug) => cancel.mutate({ workspaceId, slug }),
			onSetMode: (slug, mode) => setMode.mutate({ workspaceId, slug, mode }),
			onAnswer: (slug, answers) =>
				answer.mutate({ workspaceId, slug, answers }),
			onRunStep: (slug, kind, model, customRoleId) =>
				runStep.mutate({ workspaceId, slug, kind, model, customRoleId }),
			onSetSpecialist: (slug, specialist) =>
				setSpecialist.mutate({ workspaceId, slug, specialist }),
			onMoveHere: (slug) => moveHere.mutate({ workspaceId, slug }),
			onSetBudget: (slug, budgetUsd) =>
				setBudget.mutate({ workspaceId, slug, budgetUsd }),
			onSaveChecks: (commands) => setChecks.mutate({ workspaceId, commands }),
			onRefreshHistory: (slug) => refreshHistory.mutate({ workspaceId, slug }),
			onExcludeHistory: (slug, conversationId) =>
				excludeHistory.mutate({ workspaceId, slug, conversationId }),
			onClearHistory: (slug) => clearHistory.mutate({ workspaceId, slug }),
			onOpenSession: (slug, runId) => {
				void (async () => {
					try {
						const session = await utils.workflow.sessionCommand.fetch({
							workspaceId,
							slug,
							runId,
						});
						await launchInNewTab(
							workspaceId,
							`Session · ${slug}`,
							session.command,
						);
					} catch (err) {
						onError(err as { message: string });
					}
				})();
			},
		}),
		[
			busy,
			workspaceId,
			createTask,
			attachments.ids,
			openUrl,
			approveCommand,
			removeApproval,
			start,
			resume,
			pause,
			cancel,
			setMode,
			answer,
			runStep,
			moveHere,
			setBudget,
			setChecks,
			refreshHistory,
			excludeHistory,
			clearHistory,
			setSpecialist,
			utils,
			launchInNewTab,
		],
	);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-[520px] overflow-y-auto sm:max-w-[520px]">
				<SheetHeader>
					<SheetTitle>Tasks{data ? ` · ${data.project.name}` : ""}</SheetTitle>
					<SheetDescription>
						Describe what you want. ADE picks the cheapest route that fits and
						runs it to a verified finish.
					</SheetDescription>
				</SheetHeader>
				<TasksPanelView
					composer={{
						tray: (
							<AttachmentTray
								items={attachments.items}
								onRemove={attachments.remove}
							/>
						),
						tools: (
							<ComposerTools
								onAttach={() => void attachments.pick()}
								voice={voice}
							/>
						),
						onPaste: attachments.onPaste,
						onDrop: attachments.onDrop,
					}}
					data={data}
					error={error?.message}
					checks={checks}
					approvals={approvals}
					description={description}
					preview={preview}
					actions={actions}
					specialists={specialists}
				/>
			</SheetContent>
		</Sheet>
	);
}
