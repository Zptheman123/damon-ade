import type { BaseTab, Pane } from "shared/tabs-types";

/** A new tab may not have reported "claude" as its title yet. */
const STARTING_MS = 15_000;

/**
 * The terminal pane of a team's Team chat, and whether a message can be
 * typed into it now: Claude Code is running there (the tab's title follows
 * the terminal's, "claude" while it runs) and waiting for input, not
 * replying or asking for a permission. Never a plain shell, which would run
 * typed text as a command.
 */
export function teamChatPane(
	state: { tabs: BaseTab[]; panes: Record<string, Pane> },
	workspaceId: string,
	tabName: string,
	now: number,
): { paneId: string; ready: boolean } | undefined {
	const tabs = state.tabs.filter(
		(t) =>
			t.workspaceId === workspaceId &&
			(t.userTitle ?? t.name) === tabName &&
			/claude/i.test(t.name),
	);
	for (const tab of tabs) {
		const pane = Object.values(state.panes).find(
			(p) => p.tabId === tab.id && p.type === "terminal",
		);
		if (!pane) continue;
		const ready =
			pane.status === "idle" ||
			pane.status === "review" ||
			(pane.status === undefined && now - tab.createdAt > STARTING_MS);
		return { paneId: pane.id, ready };
	}
	return undefined;
}
