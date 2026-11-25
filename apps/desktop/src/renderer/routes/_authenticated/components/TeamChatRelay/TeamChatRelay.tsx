import { useCallback, useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { teamChatPane } from "./utils/teamChatPane";

interface Notice {
	workspaceId: string;
	message: string;
	at: number;
}

/** How often waiting notices are tried again. */
const RETRY_MS = 5_000;
/** After typing one notice, give Claude time to start on it. */
const GAP_MS = 8_000;
/** A notice nobody could take is dropped (ADE approves reviews by itself). */
const MAX_AGE_MS = 30 * 60_000;
/** Between typing and Enter, so it is not taken as a paste. */
const SUBMIT_DELAY_MS = 150;

/**
 * The agents talk back: when a subtask of a plan the Team chat started
 * finishes or stops, or the plan ends, ADE types a one-line "[ADE]" notice
 * into that team's Team chat, as soon as its Claude is waiting for input.
 * The Team chat then reviews the work and approves it or asks for changes.
 * Mounted once for the whole app, so it works while another team is shown.
 */
export function TeamChatRelay() {
	const utils = electronTrpc.useUtils();
	const write = electronTrpc.terminal.write.useMutation();
	const queue = useRef<Notice[]>([]);
	const lastSent = useRef(new Map<string, number>());
	const flushing = useRef(false);

	const flush = useCallback(async () => {
		if (flushing.current || queue.current.length === 0) return;
		flushing.current = true;
		try {
			const now = Date.now();
			queue.current = queue.current.filter((n) => now - n.at < MAX_AGE_MS);
			for (const notice of [...queue.current]) {
				const since = lastSent.current.get(notice.workspaceId) ?? 0;
				if (Date.now() - since < GAP_MS) continue;
				const launch = await utils.workflow.teamChatLaunch.fetch(
					{ workspaceId: notice.workspaceId },
					{ staleTime: Number.POSITIVE_INFINITY },
				);
				if (!launch.enabled) {
					queue.current = queue.current.filter((n) => n !== notice);
					continue;
				}
				const target = teamChatPane(
					useTabsStore.getState(),
					notice.workspaceId,
					launch.tabName,
					Date.now(),
				);
				if (!target?.ready) continue;
				// One line of plain text: Enter would send it early.
				const text = Array.from(notice.message, (ch) => {
					const code = ch.charCodeAt(0);
					return code < 32 || code === 127 ? " " : ch;
				})
					.join("")
					.trim();
				await write.mutateAsync({ paneId: target.paneId, data: text });
				await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
				await write.mutateAsync({ paneId: target.paneId, data: "\r" });
				lastSent.current.set(notice.workspaceId, Date.now());
				queue.current = queue.current.filter((n) => n !== notice);
			}
		} catch (error) {
			console.warn("[team-chat] Could not tell the Team chat:", error);
		} finally {
			flushing.current = false;
		}
	}, [utils, write]);

	electronTrpc.workflow.onCoordinatorEvent.useSubscription(undefined, {
		onData: (event) => {
			queue.current.push({
				workspaceId: event.workspaceId,
				message: event.message,
				at: Date.now(),
			});
			void flush();
		},
	});

	useEffect(() => {
		const timer = setInterval(() => void flush(), RETRY_MS);
		return () => clearInterval(timer);
	}, [flush]);

	return null;
}
