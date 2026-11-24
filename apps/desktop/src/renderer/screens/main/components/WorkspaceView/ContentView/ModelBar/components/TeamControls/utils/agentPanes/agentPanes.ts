import type { BaseTab, Pane, PaneStatus } from "shared/tabs-types";

/**
 * The terminal panes of these workspaces whose Claude session is in one of
 * these states. The states come from Claude's own hooks (Start, Stop,
 * PermissionRequest), so a pane listed here is running Claude, never a
 * plain shell that would run typed text as a command.
 */
export function agentPanes(
	state: { tabs: BaseTab[]; panes: Record<string, Pane> },
	workspaceIds: string[],
	statuses: PaneStatus[],
): string[] {
	const workspaceOf = new Map(state.tabs.map((t) => [t.id, t.workspaceId]));
	const team = new Set(workspaceIds);
	return Object.values(state.panes)
		.filter(
			(pane) =>
				pane.type === "terminal" &&
				!!pane.status &&
				statuses.includes(pane.status) &&
				team.has(workspaceOf.get(pane.tabId) ?? ""),
		)
		.map((pane) => pane.id);
}
