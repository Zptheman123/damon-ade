import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Tasks and team requests in this workspace's project that are waiting for
 * the user, kept current as tasks change (for the Tasks button's badge).
 */
export function useAttention(workspaceId: string | undefined) {
	const utils = electronTrpc.useUtils();
	const { data } = electronTrpc.workflow.attention.useQuery(
		{ workspaceId: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	electronTrpc.workflow.onTaskChanged.useSubscription(undefined, {
		enabled: !!workspaceId,
		onData: () => {
			void utils.workflow.attention.invalidate({
				workspaceId: workspaceId ?? "",
			});
		},
	});
	return data ?? [];
}
