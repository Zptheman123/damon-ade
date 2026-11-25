import { trustFolderForClaude } from "main/lib/agent-setup/claude-trust";
import {
	WORKFLOW_ENV,
	workflowEnvFor,
} from "main/lib/agent-workflow/workflow-env";
import { getSupersetHomeDir } from "main/lib/app-environment";
import { getLocalToken } from "main/lib/notifications/local-auth";
import { getTerminalHostClient } from "main/lib/terminal-host/client";
import type { ListSessionsResponse } from "main/lib/terminal-host/types";
import { electronCipher } from "main/lib/vercel/electron-cipher";
import { syncVercelMcpConfig } from "main/lib/vercel/mcp";
import { writeVercelProjectFile } from "main/lib/vercel/project-file";
import { teamVercelLink } from "main/lib/vercel/service";
import { env as sharedEnv } from "shared/env.shared";
import { DaemonTerminalManager, getDaemonTerminalManager } from "./daemon";
import { prewarmTerminalEnv, setWorkflowEnvResolver } from "./env";
import {
	RECONCILE_STARTUP_TIMEOUT_MS,
	reconcileWithTimeout,
} from "./reconcile";

// Every terminal's claude gets its project's workflow roles and task folder
// (main process only; env.ts is shared with the terminal-host subprocess).
// The hook token lets the notify hook record usage (notifications/local-auth.ts).
setWorkflowEnvResolver((project) => {
	const env = workflowEnvFor(getSupersetHomeDir(), project) ?? {};
	// The wrapper adds the team's task folder with --add-dir: trust it once,
	// so Claude Code does not ask in every session (claude-trust.ts).
	const tasksDir = env[WORKFLOW_ENV.tasksDir];
	if (tasksDir) {
		try {
			trustFolderForClaude(tasksDir);
		} catch (error) {
			console.warn("[terminal] Could not record task folder trust:", error);
		}
	}
	// Vercel connected: claude in this terminal gets the team's Vercel tools
	// (the wrapper adds --mcp-config when the file exists).
	let vercelMcp: string | undefined;
	if (project.workspaceId) {
		try {
			vercelMcp = syncVercelMcpConfig(
				{ homeDir: getSupersetHomeDir(), cipher: electronCipher() },
				project.workspaceId,
				sharedEnv.DESKTOP_NOTIFICATIONS_PORT,
			);
		} catch (error) {
			console.warn("[terminal] Could not set up the Vercel tools:", error);
		}
	}
	// A team linked to its Vercel project: this folder's Vercel CLI uses it.
	const folder = project.workspacePath ?? project.rootPath;
	if (vercelMcp && project.rootPath && folder) {
		try {
			const link = teamVercelLink(getSupersetHomeDir(), project.rootPath);
			if (link) writeVercelProjectFile(folder, link);
		} catch (error) {
			console.warn("[terminal] Could not write the Vercel project:", error);
		}
	}
	return {
		...env,
		SUPERSET_HOOK_TOKEN: getLocalToken(getSupersetHomeDir(), "hook"),
		...(vercelMcp ? { SUPERSET_VERCEL_MCP: vercelMcp } : {}),
	};
});

export { DaemonTerminalManager, getDaemonTerminalManager };
export type {
	CreateSessionParams,
	SessionResult,
	TerminalDataEvent,
	TerminalEvent,
	TerminalExitEvent,
} from "./types";

const DEBUG_TERMINAL = process.env.SUPERSET_TERMINAL_DEBUG === "1";
let prewarmInFlight: Promise<void> | null = null;

/**
 * Reconcile daemon sessions on app startup.
 * Cleans up stale sessions from previous app runs and preserves sessions
 * that can be retained. Bounded by a hard timeout so a wedged daemon can never
 * brick boot — reconcileOnStartup runs before the main window is created (see
 * reconcileWithTimeout). `timeoutMs` is injectable for tests.
 */
export async function reconcileDaemonSessions(
	timeoutMs: number = RECONCILE_STARTUP_TIMEOUT_MS,
): Promise<void> {
	await reconcileWithTimeout(getDaemonTerminalManager(), timeoutMs);
}

/**
 * Restart the terminal daemon. Kills all sessions, shuts down the daemon,
 * and resets the manager so a fresh daemon spawns on next use.
 */
export async function restartDaemon(): Promise<{ success: boolean }> {
	console.log("[restartDaemon] Starting daemon restart...");

	try {
		const client = getTerminalHostClient();
		const connected = await client.tryConnectAndAuthenticate();

		if (connected) {
			const { sessions } = await client.listSessions();
			const aliveCount = sessions.filter((s) => s.isAlive).length;
			console.log(
				`[restartDaemon] Shutting down daemon with ${aliveCount} alive sessions`,
			);

			await client.shutdownIfRunning({ killSessions: true });
		} else {
			console.log("[restartDaemon] Daemon was not running");
		}
	} catch (error) {
		console.warn("[restartDaemon] Error during shutdown (continuing):", error);
	}

	const manager = getDaemonTerminalManager();
	manager.reset();

	console.log("[restartDaemon] Complete");

	return { success: true };
}

export async function tryListExistingDaemonSessions(): Promise<{
	sessions: ListSessionsResponse["sessions"];
}> {
	try {
		const client = getTerminalHostClient();
		const result = await client.listSessions();
		return { sessions: result.sessions };
	} catch (error) {
		console.warn(
			"[TerminalManager] Failed to list existing daemon sessions (getTerminalHostClient/client.listSessions):",
			error,
		);
		if (DEBUG_TERMINAL) {
			console.log(
				"[TerminalManager] Failed to list existing daemon sessions:",
				error,
			);
		}
		return { sessions: [] };
	}
}

/**
 * Best-effort terminal runtime warmup.
 * Runs in the background to reduce latency for the first user-opened terminal:
 * - precomputes locale/env fallback
 * - ensures daemon control/stream channels are established
 */
export function prewarmTerminalRuntime(): void {
	if (prewarmInFlight) return;

	prewarmInFlight = (async () => {
		try {
			prewarmTerminalEnv();
		} catch (error) {
			if (DEBUG_TERMINAL) {
				console.warn(
					"[TerminalManager] Failed to prewarm terminal env:",
					error,
				);
			}
		}

		try {
			await getTerminalHostClient().ensureConnected();
		} catch (error) {
			if (DEBUG_TERMINAL) {
				console.warn(
					"[TerminalManager] Failed to prewarm terminal daemon connection:",
					error,
				);
			}
		}
	})().finally(() => {
		prewarmInFlight = null;
	});
}
