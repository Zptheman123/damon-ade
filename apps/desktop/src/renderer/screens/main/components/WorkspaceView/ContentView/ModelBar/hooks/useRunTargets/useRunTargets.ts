import { useCallback, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

const MAX_LINES = 1500;

/**
 * A workspace's run targets and their live state: refreshed whenever a run
 * changes, with the log of any target being watched kept up to date.
 */
export function useRunTargets(workspaceId: string | undefined, enabled = true) {
	const utils = electronTrpc.useUtils();
	const [logs, setLogs] = useState<Record<string, string[]>>({});
	const query = electronTrpc.runTargets.list.useQuery(
		{ workspaceId: workspaceId ?? "" },
		{ enabled: !!workspaceId && enabled },
	);

	electronTrpc.runTargets.onEvent.useSubscription(
		{ workspaceId: workspaceId ?? "" },
		{
			enabled: !!workspaceId,
			onData: (event) => {
				if (event.type === "state") {
					void utils.runTargets.list.invalidate({
						workspaceId: workspaceId ?? "",
					});
					return;
				}
				const lines = event.lines ?? [];
				const id = event.state.targetId;
				setLogs((current) => {
					if (!(id in current)) return current;
					const next = [...current[id], ...lines];
					return {
						...current,
						[id]: next.length > MAX_LINES ? next.slice(-MAX_LINES) : next,
					};
				});
			},
		},
	);

	/** Start following a target's log (loads what it printed so far). */
	const watchLogs = useCallback(
		async (targetId: string) => {
			if (!workspaceId) return;
			const lines = await utils.runTargets.logs.fetch({
				workspaceId,
				targetId,
			});
			setLogs((current) => ({ ...current, [targetId]: lines }));
		},
		[utils, workspaceId],
	);

	const unwatchLogs = useCallback((targetId: string) => {
		setLogs((current) => {
			const { [targetId]: _, ...rest } = current;
			return rest;
		});
	}, []);

	const live = (query.data?.targets ?? []).filter(
		(t) =>
			t.run &&
			["starting", "ready", "running", "stopping"].includes(t.run.status),
	);

	return {
		data: query.data,
		error: query.error?.message,
		live,
		logs,
		watchLogs,
		unwatchLogs,
		refresh: () =>
			utils.runTargets.list.invalidate({ workspaceId: workspaceId ?? "" }),
	};
}
