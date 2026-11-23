import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTasksSheet } from "renderer/stores/tasks-sheet";
import { AgentActivityView } from "./components/AgentActivityView";

/**
 * The workspace's agent at a glance, kept live: ADE's task runs happen in
 * the background, so without this an agent's workspace looks empty.
 */
export function AgentActivityBar() {
	const { workspaceId } = useParams({ strict: false });
	const utils = electronTrpc.useUtils();
	const setTasksOpen = useTasksSheet((s) => s.setOpen);
	const { data } = electronTrpc.workflow.agentActivity.useQuery(
		{ workspaceId: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	electronTrpc.workflow.onTaskChanged.useSubscription(undefined, {
		enabled: !!workspaceId,
		onData: () => {
			void utils.workflow.agentActivity.invalidate({
				workspaceId: workspaceId ?? "",
			});
		},
	});
	// Elapsed time ticks while something runs.
	const [now, setNow] = useState(() => Date.now());
	const running = !!data?.current;
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);

	if (!workspaceId || !data) return null;
	return (
		<AgentActivityView
			current={data.current}
			waiting={data.waiting}
			queued={data.queued}
			recent={data.recent}
			now={running ? now : Date.now()}
			onOpenTasks={() => setTasksOpen(true)}
		/>
	);
}
