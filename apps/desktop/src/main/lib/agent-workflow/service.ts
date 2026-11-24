import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { env } from "shared/env.shared";
import { resolveClaudeExecutable } from "../agent-invoke/headless-run";
import { findRealBinary } from "../agent-setup/utils";
import { getSupersetHomeDir } from "../app-environment";
import { findGitBash } from "../terminal/windows-shell";
import { treeKillWithEscalation } from "../tree-kill";
import { scheduleSessionRecording, transcriptPathFor } from "../usage-metrics";
import { electronCipher } from "../vercel/electron-cipher";
import { syncVercelMcpConfig, VERCEL_READ_TOOL_RULES } from "../vercel/mcp";
import { teamVercelLink } from "../vercel/service";
import { runChecks } from "./checks";
import { TaskController } from "./controller";
import { runAuditCommand } from "./dependency-audit";
import { listWorkflowProjects, type ProjectWorkflow } from "./project-workflow";
import { startStageRun } from "./stage-runner";
import { createTaskNotifier } from "./task-notices";
import { getTask, listTaskRecords } from "./tasks";
import { loadWorkflowSettings } from "./workflow-settings";

/**
 * The controller ADE's main process uses: real `claude -p` runs, checks run
 * through the user's shell, and process-tree kills. One per app, so the
 * per-task lock and the live-run table are shared by every caller.
 */

export interface TaskChangeEvent {
	projectKey: string;
	slug: string;
}

export const workflowEvents = new EventEmitter();
workflowEvents.setMaxListeners(50);

const killTree = async (pid: number): Promise<void> => {
	await treeKillWithEscalation({ pid });
};

/** How check commands are run: Git Bash on Windows when present, else cmd. */
export function checkShell(): string[] {
	if (process.platform === "win32") {
		const bash = findGitBash();
		return bash ? [bash, "-lc"] : ["cmd.exe", "/d", "/s", "/c"];
	}
	return [process.env.SHELL || "/bin/sh", "-lc"];
}

let controller: TaskController | undefined;

/** Desktop notifications when a task or team request stops or finishes. */
const notifier = createTaskNotifier((notice) => {
	console.log(`[workflow] ${notice.title}: ${notice.body}`);
	// Loaded here, not at the top: this module is also imported by tests.
	void import("electron")
		.then(({ BrowserWindow, Notification }) => {
			if (!Notification?.isSupported()) return;
			const shown = new Notification({
				title: notice.title,
				body: notice.body,
			});
			shown.on("click", () => {
				const window = BrowserWindow.getAllWindows()[0];
				window?.show();
				window?.focus();
			});
			shown.show();
		})
		.catch((error) =>
			console.warn("[workflow] Could not show a notification:", error),
		);
});

/** Start-up: every task's current state, so only later changes notify. */
function seedNotices(): void {
	for (const project of listWorkflowProjects(getSupersetHomeDir())) {
		for (const task of listTaskRecords(project))
			notifier.seed(project.key, task);
	}
}

export function getTaskController(): TaskController {
	if (controller) return controller;
	const homeDir = getSupersetHomeDir();
	try {
		seedNotices();
	} catch (error) {
		console.warn("[workflow] Could not read task states:", error);
	}
	controller = new TaskController({
		homeDir,
		loadSettings: () => loadWorkflowSettings(homeDir),
		resolveClaude: () => {
			const executable = resolveClaudeExecutable(findRealBinary("claude"));
			return executable ? [executable] : null;
		},
		startRun: (spec, onProgress) =>
			startStageRun(spec, { killTree, onProgress }),
		runChecks: ({ cwd, commands, signal, continuePast }) =>
			runChecks({
				cwd,
				commands,
				signal,
				continuePast,
				shell: checkShell(),
				killTree,
			}),
		// Auto's dependency audit: the project's own package manager.
		runAudit: runAuditCommand(killTree),
		newId: randomUUID,
		now: () => new Date(),
		env: process.env,
		// A team linked to its Vercel website: its runs can read the site,
		// deployments and build logs (read-only tools, ADE holds the token).
		extraTools: (project, task) => {
			const workspaceId = task.identity.workspaceId;
			if (!workspaceId || !teamVercelLink(homeDir, project.root)) return;
			const mcpConfig = syncVercelMcpConfig(
				{ homeDir, cipher: electronCipher() },
				workspaceId,
				env.DESKTOP_NOTIFICATIONS_PORT,
			);
			return mcpConfig
				? { mcpConfig, allowedTools: VERCEL_READ_TOOL_RULES }
				: undefined;
		},
		// Task runs are recorded like terminal sessions, under the project, so
		// `bun run workflow report` includes them (the panel counts them once,
		// from task.json).
		onRunFinished: (project, task, run) => {
			if (!run.sessionId) return;
			scheduleSessionRecording({
				transcriptPath: transcriptPathFor(
					task.identity.worktreePath,
					run.sessionId,
				),
				workspaceId: task.identity.workspaceId || undefined,
				projectKey: project.key,
			});
		},
		onChange: (project: ProjectWorkflow, slug: string) => {
			workflowEvents.emit("task-changed", {
				projectKey: project.key,
				slug,
			} satisfies TaskChangeEvent);
			// Tell the user when work stops or finishes (task-notices.ts).
			const task = getTask(project, slug);
			if (task) notifier.changed(project.key, task);
		},
	});
	return controller;
}

/** App quit: stop every managed run's process tree. */
export async function shutdownWorkflowRuns(): Promise<void> {
	if (controller) await controller.shutdown();
}

/**
 * At startup: runs that were in flight when ADE stopped are marked
 * interrupted and their tasks paused. Nothing paid is re-run.
 */
export function recoverWorkflowTasks(): number {
	const recovered = getTaskController().recover(
		listWorkflowProjects(getSupersetHomeDir()),
		(project) => listTaskRecords(project).map((task) => task.slug),
	);
	if (recovered > 0) {
		console.log(
			`[workflow] ${recovered} task(s) paused after an interrupted run`,
		);
	}
	return recovered;
}
