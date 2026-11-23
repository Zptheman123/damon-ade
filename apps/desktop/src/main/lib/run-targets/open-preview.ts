import type { RunTarget } from "main/lib/project-type/config";
import { browserPreview } from "./preview";
import {
	isLocalUrl,
	type RunEvent,
	type RunManager,
	type RunState,
} from "./run-manager";

/**
 * "Open localhost": open a run target's local address in the user's
 * browser. Uses the run manager ADE already has (no second process
 * manager): a running target is opened once it answers; a stopped one is
 * started with its configured command only when the user asked to run it.
 * Only loopback addresses are opened. No model is involved.
 */

export type OpenResult =
	| { status: "opened"; url: string; startedNow: boolean }
	| { status: "stopped"; message: string }
	| { status: "failed"; message: string; logTail: string[] };

const LIVE = new Set(["starting", "ready", "running", "stopping"]);

/** Wait until the run is ready, or has clearly not become ready. */
function settled(
	manager: RunManager,
	workspaceId: string,
	targetId: string,
	timeoutMs: number,
): Promise<RunState | undefined> {
	const now = manager.get(workspaceId, targetId);
	const done = (s: RunState | undefined) =>
		!s ||
		s.status === "ready" ||
		!LIVE.has(s.status) ||
		// The readiness check gave up: running, but not answering.
		(s.status === "running" && !!s.error);
	if (done(now)) return Promise.resolve(now);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			manager.off("event", onEvent);
			resolve(manager.get(workspaceId, targetId));
		}, timeoutMs);
		const onEvent = (event: RunEvent) => {
			if (
				event.type !== "state" ||
				event.state.workspaceId !== workspaceId ||
				event.state.targetId !== targetId
			) {
				return;
			}
			if (done(event.state)) {
				clearTimeout(timer);
				manager.off("event", onEvent);
				resolve(event.state);
			}
		};
		manager.on("event", onEvent);
	});
}

const inFlight = new Map<string, Promise<OpenResult>>();

export function openTargetInBrowser(options: {
	manager: RunManager;
	workspaceId: string;
	worktree: string;
	target: RunTarget;
	projectType?: string;
	/** Start it when it is stopped ("Run and open"). */
	start: boolean;
	open: (url: string) => Promise<void>;
	timeoutMs?: number;
}): Promise<OpenResult> {
	const { manager, workspaceId, target } = options;
	const key = `${workspaceId}::${target.id}`;
	// A second click while one is starting gets the same result: one
	// server, one browser tab.
	const pending = inFlight.get(key);
	if (pending) return pending;
	const work = (async (): Promise<OpenResult> => {
		const preview = browserPreview(
			target,
			options.worktree,
			options.projectType,
		);
		if (preview.kind === "none") {
			return { status: "failed", message: preview.reason, logTail: [] };
		}
		let state = manager.get(workspaceId, target.id);
		let startedNow = false;
		if (!state || !LIVE.has(state.status)) {
			if (!options.start) {
				return {
					status: "stopped",
					message: `"${target.name}" is not running. Use Run and open to start it.`,
				};
			}
			state = manager.start({
				workspaceId,
				worktree: options.worktree,
				target,
			});
			startedNow = true;
		}
		state = await settled(
			manager,
			workspaceId,
			target.id,
			options.timeoutMs ?? 120_000,
		);
		const logTail = manager.logs(workspaceId, target.id).slice(-15);
		if (!state || state.status !== "ready" || !state.url) {
			const why =
				state?.error ??
				(state && !LIVE.has(state.status)
					? `It ${state.status === "failed" ? "failed" : "stopped"} before it answered.`
					: "It did not answer in time.");
			return {
				status: "failed",
				message: `"${target.name}" is not ready: ${why}`,
				logTail,
			};
		}
		if (!isLocalUrl(state.url)) {
			return {
				status: "failed",
				message: `${state.url} is not on this computer, so ADE will not open it.`,
				logTail,
			};
		}
		await options.open(state.url);
		return { status: "opened", url: state.url, startedNow };
	})().finally(() => inFlight.delete(key));
	inFlight.set(key, work);
	return work;
}
