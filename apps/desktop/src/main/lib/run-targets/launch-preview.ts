import type { RunTarget } from "main/lib/project-type/config";
import { type OpenResult, openTargetInBrowser } from "./open-preview";
import { browserPreview } from "./preview";
import type { RunEvent, RunManager, RunState } from "./run-manager";

/**
 * The Preview button: one click shows the app, whatever it is.
 *
 * - A web app (or a web build, or a renderer that runs in a browser): opened
 *   at its local address once it answers (open-preview.ts).
 * - A desktop app: started with its command; it opens its own window.
 * - A mobile app without a web build: started; its device address (exp://…)
 *   is returned for a phone to open (Expo Go) or to scan as a QR code.
 *
 * Only the team's own target, only when the user clicks. No model involved.
 */

export type PreviewResult =
	| OpenResult
	| {
			status: "launched";
			/** What the user sees next. */
			message: string;
			startedNow: boolean;
	  }
	| {
			status: "device";
			deviceUrl: string;
			/** A web address it also serves, when it printed one. */
			url?: string;
			startedNow: boolean;
	  };

const LIVE = new Set(["starting", "ready", "running", "stopping"]);
const ENDED = (s: RunState | undefined) => !!s && !LIVE.has(s.status);

/** Wait until `done` holds for the run, it ends, or the time is up. */
function waitFor(
	manager: RunManager,
	workspaceId: string,
	targetId: string,
	done: (s: RunState) => boolean,
	timeoutMs: number,
): Promise<RunState | undefined> {
	const now = manager.get(workspaceId, targetId);
	if (!now || ENDED(now) || done(now)) return Promise.resolve(now);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			manager.off("event", onEvent);
			resolve(manager.get(workspaceId, targetId));
		}, timeoutMs);
		const onEvent = (event: RunEvent) => {
			if (
				event.state.workspaceId !== workspaceId ||
				event.state.targetId !== targetId
			) {
				return;
			}
			if (ENDED(event.state) || done(event.state)) {
				clearTimeout(timer);
				manager.off("event", onEvent);
				resolve(manager.get(workspaceId, targetId) ?? event.state);
			}
		};
		manager.on("event", onEvent);
	});
}

function failure(
	manager: RunManager,
	workspaceId: string,
	target: RunTarget,
	state: RunState | undefined,
): OpenResult {
	return {
		status: "failed",
		message: `"${target.name}" ${
			state?.status === "failed" ? "failed" : "stopped"
		} before it opened${state?.error ? `: ${state.error}` : "."}`,
		logTail: manager.logs(workspaceId, target.id).slice(-15),
	};
}

export async function launchPreview(options: {
	manager: RunManager;
	workspaceId: string;
	worktree: string;
	target: RunTarget;
	projectType?: string;
	/** Start it when it is stopped. */
	start: boolean;
	open: (url: string) => Promise<void>;
	/** How long a desktop app may take to crash before it counts as open. */
	settleMs?: number;
	/** How long to wait for a mobile app's device address. */
	deviceTimeoutMs?: number;
	timeoutMs?: number;
}): Promise<PreviewResult> {
	const { manager, workspaceId, target } = options;
	// A desktop or mobile app is shown as itself (its window, a phone), not
	// as a browser build of it; everything else opens in the browser.
	if (target.kind !== "desktop" && target.kind !== "mobile") {
		const preview = browserPreview(
			target,
			options.worktree,
			options.projectType,
		);
		if (preview.kind === "none") {
			return { status: "failed", message: preview.reason, logTail: [] };
		}
		return openTargetInBrowser(options);
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
		if (ENDED(state)) return failure(manager, workspaceId, target, state);
	}

	if (target.kind === "desktop") {
		// Its window is its own: count it open unless it crashes right away.
		state = await waitFor(
			manager,
			workspaceId,
			target.id,
			(s) => s.status === "ready",
			startedNow ? (options.settleMs ?? 8000) : 0,
		);
		if (!state || ENDED(state)) {
			return failure(manager, workspaceId, target, state);
		}
		return {
			status: "launched",
			startedNow,
			message: startedNow
				? `Starting "${target.name}". Its window opens in a few seconds.`
				: `"${target.name}" is already running in its own window.`,
		};
	}

	state = await waitFor(
		manager,
		workspaceId,
		target.id,
		(s) => !!s.deviceUrl,
		options.deviceTimeoutMs ?? 90_000,
	);
	if (!state || ENDED(state)) {
		return failure(manager, workspaceId, target, state);
	}
	if (state.deviceUrl) {
		return {
			status: "device",
			deviceUrl: state.deviceUrl,
			url: state.url,
			startedNow,
		};
	}
	return {
		status: "launched",
		startedNow,
		message: `"${target.name}" is running but has not printed a device address yet. Open Run to see its log.`,
	};
}
