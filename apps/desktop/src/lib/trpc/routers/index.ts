import type { BrowserWindow } from "electron";
import { router } from "..";
import { createAttachmentsRouter } from "./attachments";
import { createAuthRouter } from "./auth";
import { createAutoUpdateRouter } from "./auto-update";
import { createBrowserRouter } from "./browser/browser";
import { createBrowserHistoryRouter } from "./browser-history";
import { createCacheRouter } from "./cache";
import { createChangesRouter } from "./changes";
import { createConfigRouter } from "./config";
import { createExternalRouter } from "./external";
import { createFilesystemRouter } from "./filesystem";
import { createHotkeysRouter } from "./hotkeys";
import { createMenuRouter } from "./menu";
import { createNotificationsRouter } from "./notifications";
import { createPermissionsRouter } from "./permissions";
import { createPortsRouter } from "./ports";
import { createProjectConfigRouter } from "./project-config";
import {
	createDefaultProjectHistoryDeps,
	createProjectHistoryRouter,
} from "./project-history";
import { createProjectsRouter } from "./projects";
import { createRepoUpdateRouter } from "./repo-update";
import { createResourceMetricsRouter } from "./resource-metrics";
import { createRingtoneRouter } from "./ringtone";
import { createRunTargetsRouter } from "./run-targets";
import { createSettingsRouter } from "./settings";
import { createSpecialistsRouter } from "./specialists";
import { createSyncRouter } from "./sync";
import { createTerminalRouter } from "./terminal";
import { createUiStateRouter } from "./ui-state";
import { createVercelRouter } from "./vercel";
import { createVoiceRouter } from "./voice";
import { createWindowRouter } from "./window";
import { createWorkflowRouter } from "./workflow";
import { createWorkspacesRouter } from "./workspaces";

export const createAppRouter = (getWindow: () => BrowserWindow | null) => {
	return router({
		browser: createBrowserRouter(),
		browserHistory: createBrowserHistoryRouter(),
		auth: createAuthRouter(),
		autoUpdate: createAutoUpdateRouter(),
		cache: createCacheRouter(),
		window: createWindowRouter(getWindow),
		projects: createProjectsRouter(getWindow),
		projectConfig: createProjectConfigRouter(),
		attachments: createAttachmentsRouter(),
		voice: createVoiceRouter(),
		runTargets: createRunTargetsRouter(),
		vercel: createVercelRouter(),
		workspaces: createWorkspacesRouter(),
		terminal: createTerminalRouter(),
		changes: createChangesRouter(),
		filesystem: createFilesystemRouter(),
		notifications: createNotificationsRouter(),
		permissions: createPermissionsRouter(),
		ports: createPortsRouter(),
		resourceMetrics: createResourceMetricsRouter(),
		menu: createMenuRouter(),
		hotkeys: createHotkeysRouter(getWindow),
		external: createExternalRouter(),
		settings: createSettingsRouter(),
		config: createConfigRouter(),
		uiState: createUiStateRouter(),
		sync: createSyncRouter(),
		ringtone: createRingtoneRouter(getWindow),
		workflow: createWorkflowRouter(),
		repoUpdate: createRepoUpdateRouter(),
		specialists: createSpecialistsRouter(),
		projectHistory: createProjectHistoryRouter(
			createDefaultProjectHistoryDeps(getWindow),
		),
	});
};

export type AppRouter = ReturnType<typeof createAppRouter>;
