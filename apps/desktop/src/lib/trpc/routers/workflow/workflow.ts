import { join } from "node:path";
import { projects, workspaces } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { eq } from "drizzle-orm";
import {
	activeRun,
	buildResumeCommand,
	captureIdentity,
	changedFilesOf,
	chooseSpecialists,
	codeState,
	createTask,
	currentBranch,
	customRoleContext,
	decideNext,
	defaultWorkflowSettings,
	EFFORT_LEVELS,
	effectiveChecks,
	ensureProjectWorkflow,
	evidenceView,
	getTask,
	identityMismatch,
	listSpecialists,
	listTaskRecords,
	loadProjectChecks,
	loadWorkflowSettings,
	PERMISSION_PROFILES,
	type ProjectWorkflow,
	ROLE_NAMES,
	RUN_KINDS,
	readTaskFiles,
	refreshAllProjectWorkflows,
	resolveSpecialist,
	saveProjectChecks,
	saveTask,
	saveWorkflowSettings,
	stageModel,
	stageRouting,
	suggestChecks,
	TaskController,
	type TaskIdentity,
	type TaskRecord,
	taskDir,
	taskSpecialists,
	taskSpend,
	validateWorkflowSettings,
	wantsDependencyAudit,
} from "main/lib/agent-workflow";
import {
	addCommandApproval,
	approvalCovers,
	approvalProblem,
	approvalRule,
	describeDenials,
	loadCommandApprovals,
	projectCommands,
	projectCommandsEnabled,
	removeCommandApproval,
	setProjectCommands,
} from "main/lib/agent-workflow/command-approvals";
import {
	getTaskController,
	type TaskChangeEvent,
	workflowEvents,
} from "main/lib/agent-workflow/service";
import { RESEARCH_TEMPLATE_ID } from "main/lib/agent-workflow/specialist-templates";
import type { TeamAgent } from "main/lib/agent-workflow/tasks";
import { getSupersetHomeDir } from "main/lib/app-environment";
import {
	type Attachment,
	getAttachment,
} from "main/lib/attachments/attachments";
import { localDb } from "main/lib/local-db";
import {
	buildTaskHistory,
	clearTaskHistory,
	eligibleConversations,
} from "main/lib/project-history";
import {
	costOf,
	dedupeAcrossSessions,
	getMetricsDir,
	loadSessions,
} from "main/lib/usage-metrics";
import { env } from "shared/env.shared";
import { classifyTask, TASK_ROUTES } from "shared/utils/task-routing";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getWorkspacePath } from "../workspaces/utils/worktree";

/**
 * The multi-model workflow in the app (Settings > Models & Cost, and the
 * Tasks panel of every workspace). Settings are app-wide; tasks and usage are
 * per project, in <ADE home>/workflow/projects/<key>.
 *
 * Every task action goes through the TaskController (agent-workflow/
 * controller.ts): it owns the stages, runs them as child processes, holds the
 * per-task lock and records each run's outcome. The router only resolves
 * which project and worktree a request comes from, and refuses actions on a
 * task that belongs to another worktree unless the user moves it.
 */

const roleRoutingSchema = z.object({
	model: z.string(),
	effort: z.enum(EFFORT_LEVELS as [string, ...string[]]),
	maxTurns: z.number(),
});

const executionSchema = z.object({
	permissions: z.enum(PERMISSION_PROFILES),
	taskBudgetUsd: z.number(),
	maxCorrections: z.number(),
	maxReviewRounds: z.number(),
	maxEscalations: z.number(),
	pinModels: z.boolean(),
	cheaperFallback: z.boolean(),
	dependencyAudit: z.enum(["fix", "report", "off"]).optional(),
	keepGoing: z.boolean().optional(),
});

const settingsInputSchema = z.object({
	roles: z.object(
		Object.fromEntries(
			ROLE_NAMES.map((role) => [role, roleRoutingSchema]),
		) as Record<(typeof ROLE_NAMES)[number], typeof roleRoutingSchema>,
	),
	budgets: z.object({
		sessionWarnUsd: z.number().nullable(),
		dailyWarnUsd: z.number().nullable(),
		headlessMaxBudgetUsd: z.number(),
		headlessMaxTurns: z.number(),
	}),
	execution: executionSchema.optional(),
});

/** The attachments a composer sent, by id (unknown ids are dropped). */
function resolveAttachments(
	homeDir: string,
	projectKey: string,
	ids: string[],
): Attachment[] {
	return ids
		.map((id) => getAttachment(homeDir, projectKey, id))
		.filter((a): a is Attachment => !!a);
}

/** A request that explicitly asks for research or current outside facts. */
export function asksForResearch(description: string): boolean {
	return /\b(research|look up|look into|investigate|latest version|current (docs|documentation|version|api)|official (docs|documentation)|compare (libraries|options|frameworks)|which (library|framework|service) should)\b/i.test(
		description,
	);
}

/** The URLs a research run cites, in order, without duplicates. */
export function researchSources(
	summary: string | undefined,
): Array<{ url: string; title: string }> {
	if (!summary) return [];
	const seen = new Set<string>();
	const sources: Array<{ url: string; title: string }> = [];
	for (const line of summary.split("\n")) {
		for (const match of line.matchAll(/https?:\/\/[^\s)>\]"'`]+/g)) {
			const url = match[0].replace(/[.,;:]+$/, "");
			if (seen.has(url)) continue;
			seen.add(url);
			const title = line
				.replace(match[0], "")
				.replace(/^[\s*\-\d.]+/, "")
				.replace(/[\s—–:([]+$/, "")
				.replace(/\[|\]\(|\)/g, "")
				.trim();
			sources.push({ url, title: title || url });
		}
	}
	return sources.slice(0, 20);
}

function localDay(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export interface WorkspaceContext {
	workspaceId: string;
	project: ProjectWorkflow;
	/** The workspace's own folder (its worktree). */
	worktreePath: string;
	runtime: "claude" | "codex";
}

export interface WorkflowRouterDeps {
	homeDir: () => string;
	resolveWorkspace: (workspaceId: string) => WorkspaceContext;
	controller: () => TaskController;
	captureIdentity: (workspaceId: string, worktreePath: string) => TaskIdentity;
	events: NodeJS.EventEmitter;
	/** The agents of the workspace's team (default: from ADE's database). */
	listAgents?: (workspaceId: string) => TeamAgent[];
	/** Worktree probes (default: git). */
	branchOf?: (worktree: string) => string | undefined;
	codeStateOf?: (worktree: string) => string | undefined;
}

/**
 * The workflow project of a workspace: the project's main repo, or the
 * workspace's own folder when the project has none (ADE agents). Same rule as
 * the terminal environment, so the panel and the terminals agree.
 */
function resolveWorkspaceFromDb(workspaceId: string): WorkspaceContext {
	const workspace = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.get();
	if (!workspace) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
	}
	const worktreePath = getWorkspacePath(workspace);
	const project = localDb
		.select()
		.from(projects)
		.where(eq(projects.id, workspace.projectId))
		.get();
	const root = project?.mainRepoPath?.trim() || worktreePath;
	if (!root || !worktreePath) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "This workspace has no folder yet",
		});
	}
	return {
		workspaceId,
		project: ensureProjectWorkflow(getSupersetHomeDir(), root),
		worktreePath,
		runtime: workspace.runtime === "codex" ? "codex" : "claude",
	};
}

/** The agents (workspaces) of a workspace's team, with their folders. */
export function listTeamAgentsFromDb(workspaceId: string): TeamAgent[] {
	const workspace = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.get();
	if (!workspace) return [];
	return localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.projectId, workspace.projectId))
		.all()
		.filter((w) => !w.deletingAt)
		.flatMap((w) => {
			const worktreePath = getWorkspacePath(w);
			return worktreePath
				? [{ workspaceId: w.id, name: w.name, worktreePath }]
				: [];
		});
}

export const defaultWorkflowRouterDeps: WorkflowRouterDeps = {
	homeDir: getSupersetHomeDir,
	resolveWorkspace: resolveWorkspaceFromDb,
	controller: getTaskController,
	captureIdentity,
	events: workflowEvents,
	listAgents: listTeamAgentsFromDb,
};

function badRequest(error: unknown): TRPCError {
	if (error instanceof TRPCError) return error;
	return new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : String(error),
	});
}

/** Runs `fn`, turning thrown errors into BAD_REQUEST. */
async function guarded<T>(fn: () => Promise<T> | T): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw badRequest(error);
	}
}

/**
 * Choose the task's history excerpts (deterministic search, no model) and
 * record which conversations they came from. A task with no relevant
 * excerpts records an empty history, so the panel can say so.
 */
function withHistory(
	project: ProjectWorkflow,
	task: TaskRecord,
	excluded: string[],
): TaskRecord {
	const history = buildTaskHistory({
		project,
		taskDir: taskDir(project, task.slug),
		query: `${task.title}
${task.description}`,
		worktreePath: task.identity.worktreePath,
		excluded,
	});
	const updated = { ...task, history };
	saveTask(project, updated);
	return updated;
}

const roleOverrideSchema = z.object({
	model: z.string().max(100).optional(),
	effort: z.enum(EFFORT_LEVELS as [string, ...string[]]).optional(),
	maxTurns: z.number().int().min(1).max(500).optional(),
	instructions: z.string().max(10_000).optional(),
});
const roleOverridesSchema = z.object(
	Object.fromEntries(
		ROLE_NAMES.map((role) => [role, roleOverrideSchema.optional()]),
	) as Record<
		(typeof ROLE_NAMES)[number],
		z.ZodOptional<typeof roleOverrideSchema>
	>,
);

/**
 * The task's specialist: the user's choice, or Auto's keyword match against
 * the team's specialists (no model call). No specialists: default workflow.
 */
function assignSpecialist(
	homeDir: string,
	project: ProjectWorkflow,
	task: TaskRecord,
	choice: string,
	roleOverrides: Record<string, unknown> | undefined,
	workspaceId?: string,
): TaskRecord {
	const settings = loadWorkflowSettings(homeDir);
	const specialists = listSpecialists(project).map((s) =>
		resolveSpecialist(s, settings, homeDir),
	);
	let updated: TaskRecord = {
		...task,
		roleOverrides: roleOverrides as TaskRecord["roleOverrides"],
	};
	if (choice === "none") {
		updated = {
			...updated,
			specialistReason: "default workflow (chosen by you)",
		};
	} else if (choice === "auto") {
		// A task on an agent with its own specialties uses one of them.
		const own = specialists.filter(
			(s) => workspaceId && s.specialist.agentWorkspaceId === workspaceId,
		);
		const picked = chooseSpecialists(
			`${task.title}\n${task.description}`,
			own.length ? own : specialists,
		);
		const primary = picked.primary ?? own[0];
		updated = {
			...updated,
			specialistId: primary?.specialist.id,
			supportingSpecialistIds: picked.supporting.map((s) => s.specialist.id),
			specialistReason: own.length
				? `this agent's specialty${picked.primary ? ` (${picked.reason})` : ""}`
				: picked.reason,
		};
	} else {
		const chosen = specialists.find((s) => s.specialist.id === choice);
		if (!chosen) throw new Error("That specialist is not part of this team");
		updated = {
			...updated,
			specialistId: chosen.specialist.id,
			specialistReason: "chosen by you",
		};
	}
	saveTask(project, updated);
	return updated;
}

interface Probes {
	/** The workspace's branch now. */
	branchNow: string | undefined;
	/** Code state of a worktree now (cached per request). */
	codeStateOf: (worktree: string) => string | undefined;
}

/** What the panel shows for one task. */
function describeTask(
	homeDir: string,
	project: ProjectWorkflow,
	task: TaskRecord,
	ctx: WorkspaceContext,
	settings: ReturnType<typeof loadWorkflowSettings>,
	checks: { commands: string[] },
	probes: Probes,
) {
	const files = readTaskFiles(project, task.slug);
	const approvals = task.permissionBlock ? loadCommandApprovals(project) : [];
	const ownCommands =
		task.permissionBlock && projectCommandsEnabled(project)
			? projectCommands(task.identity.worktreePath)
			: [];
	const spend = taskSpend(task);
	const mismatch = identityMismatch(
		task,
		ctx.workspaceId,
		ctx.worktreePath,
		probes.branchNow,
	);
	const specialists = taskSpecialists(homeDir, project, task, settings);
	const changed = changedFilesOf(task);
	const next =
		task.state === "done" ||
		task.state === "cancelled" ||
		activeRun(task) ||
		mismatch
			? undefined
			: decideNext(task, files, checks, settings, {
					codeState: probes.codeStateOf(task.identity.worktreePath),
					customRoles: customRoleContext(specialists, task, changed),
					dependencyAudit: wantsDependencyAudit(specialists, task, changed),
				});
	let nextRouting: ReturnType<typeof stageRouting>["routing"] | null = null;
	if (next?.type === "run") {
		try {
			nextRouting = stageRouting(
				specialists,
				task,
				settings,
				next.kind,
				next.customRoleId,
			).routing;
		} catch {
			nextRouting = null;
		}
	}
	const manualBlockers = Object.fromEntries(
		RUN_KINDS.map((kind) => [
			kind,
			mismatch ??
				TaskController.manualBlocker(task, files, checks, kind) ??
				null,
		]),
	) as Record<(typeof RUN_KINDS)[number], string | null>;
	return {
		slug: task.slug,
		title: task.title,
		description: task.description,
		route: task.route,
		routeReasons: task.routeReasons,
		createdAt: task.createdAt,
		mode: task.mode,
		state: task.state,
		stateReason: task.stateReason ?? null,
		pauseRequested: task.pauseRequested ?? false,
		answers: task.answers ?? null,
		planQuestions: files.planQuestions,
		openEscalations: files.openEscalations,
		limits: task.limits,
		identity: {
			worktreePath: task.identity.worktreePath,
			branch: task.identity.branch ?? null,
		},
		/** Set when this workspace is not the task's worktree or branch. */
		mismatch: mismatch ?? null,
		moves: task.moves ?? [],
		/** Earlier conversations this task draws on (history.md). */
		history: task.history
			? {
					builtAt: task.history.builtAt,
					excerpts: task.history.excerpts,
					sources: task.history.sources,
					excluded: task.history.excluded,
					file: join(project.tasksDir, task.slug, "history.md"),
				}
			: null,
		spend,
		next: next ?? null,
		manualBlockers,
		/** The model the next stage will run on (the runner uses the same). */
		nextModel: nextRouting?.model ?? null,
		nextRole: nextRouting?.role ?? null,
		nextModelSource: nextRouting?.modelSource ?? null,
		specialist: specialists.primary
			? {
					id: specialists.primary.specialist.id,
					name: specialists.primary.specialist.name,
					specialty: specialists.primary.specialist.specialty,
				}
			: null,
		supportingSpecialists: specialists.supporting.map((s) => s.specialist.name),
		specialistReason: task.specialistReason ?? null,
		/** Specialist roles this task can run (Manual). */
		customRoles: (specialists.primary?.customRoles ?? []).map((r) => ({
			id: r.id,
			name: r.name,
			trigger: r.trigger,
			access: r.access,
		})),
		roleOverrides: task.roleOverrides ?? {},
		routeBy: task.routeBy ?? null,
		/** The AI pathway choice, once made. */
		triage: task.triage ?? null,
		/** Research: "first" (before the work) or "only" (no code changes). */
		research: task.research ?? null,
		/** Set when the user accepted the work although a step had stopped it. */
		accepted: task.accepted ?? null,
		/** Notes the user added after creating the task. */
		notes: task.notes ?? [],
		/** Whether "Accept as is" applies: stopped, with implemented work. */
		canAccept:
			!task.isRequest &&
			!activeRun(task) &&
			["blocked", "paused", "needs-input", "failed"].includes(task.state) &&
			evidenceView(task).runs.some(
				(run) =>
					run.status === "succeeded" &&
					["quick", "implement", "build", "fix"].includes(run.kind),
			),
		/** Commands the last implementing run was refused, waiting for approval. */
		permissionBlock: task.permissionBlock
			? {
					runId: task.permissionBlock.runId,
					kind: task.permissionBlock.kind,
					cwd: task.permissionBlock.cwd,
					at: task.permissionBlock.at,
					operations: describeDenials(task.permissionBlock.denials).map(
						(op) => ({
							...op,
							approved:
								approvals.some((ap) => approvalCovers(ap, op)) ||
								(!!op.command && ownCommands.includes(op.command.trim())),
							/** Whether "with any arguments" is allowed for this command. */
							prefixAllowed:
								op.approvable &&
								!!op.command &&
								!approvalProblem({
									tool: op.tool,
									command: op.command,
									match: "prefix",
								}),
						}),
					),
				}
			: null,
		attachments: (task.attachments ?? []).map((a) => ({
			id: a.id,
			name: a.name,
			kind: a.kind,
			size: a.size,
		})),
		/** A team request: the Coordinator splits it into subtasks. */
		isRequest: task.isRequest ?? false,
		/** A team chat: the conversation with the Coordinator, with its plans. */
		chat: task.chat ?? null,
		subtaskSlugs: task.subtaskSlugs ?? [],
		splitReason: task.splitReason ?? null,
		parentSlug: task.parentSlug ?? null,
		dependsOn: task.dependsOn ?? [],
		/** For a subtask: the agent doing it (null: where the request was sent). */
		agentName: task.agentName ?? null,
		resultCommit: task.resultCommit ?? null,
		runs: task.runs.map((run, index) => ({
			id: run.id,
			role: run.role ?? null,
			specialist: run.specialist ?? null,
			/** Before the task's last move: history, not evidence. */
			history: index < (task.evidenceStart ?? 0),
			kind: run.kind,
			status: run.status,
			attempt: run.attempt,
			queuedAt: run.queuedAt,
			startedAt: run.startedAt ?? null,
			endedAt: run.endedAt ?? null,
			model: run.model ?? null,
			observedModels: run.observedModels ?? [],
			effort: run.effort ?? null,
			effortNote: run.effortNote ?? null,
			maxTurns: run.maxTurns ?? null,
			permissionMode: run.permissionMode ?? null,
			maxBudgetUsd: run.maxBudgetUsd ?? null,
			sessionId: run.sessionId ?? null,
			fallbackFrom: run.fallbackFrom ?? null,
			reportedCostUsd: run.reportedCostUsd ?? null,
			liveCostUsd: run.liveCostUsd ?? null,
			costState:
				run.costState ??
				(run.kind === "checks" || run.kind === "deps" ? null : "unknown"),
			unpricedModels: run.unpricedModels ?? [],
			failure: run.failure ?? null,
			error: run.error ?? null,
			/** Tool calls the CLI refused in this run (history). */
			permissionDenials: run.permissionDenials ?? [],
			/** ADE's dependency audit (kind "deps"). */
			audit: run.audit
				? {
						state: run.audit.state,
						manager: run.audit.manager ?? null,
						summary: run.summary ?? "",
						fixed: run.audit.fixed,
						advisories: run.audit.advisories.slice(0, 8),
						notes: run.audit.notes,
						commands: run.audit.commands,
					}
				: null,
			verdict: run.verdict ?? null,
			checks: run.checks ?? null,
			summary: run.summary ? run.summary.slice(-1500) : null,
			/** A research run's sources: the web pages it cites. */
			sources: run.kind === "research" ? researchSources(run.summary) : [],
		})),
	};
}

export const createWorkflowRouter = (
	deps: WorkflowRouterDeps = defaultWorkflowRouterDeps,
) => {
	const branchOf = deps.branchOf ?? currentBranch;
	const codeStateOf = deps.codeStateOf ?? codeState;

	/** The task, after checking it may be acted on from this workspace. */
	function taskFor(
		workspaceId: string,
		slug: string,
		options: { allowOtherWorktree?: boolean } = {},
	): { ctx: WorkspaceContext; task: TaskRecord } {
		const ctx = deps.resolveWorkspace(workspaceId);
		const task = getTask(ctx.project, slug);
		if (!task)
			throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
		if (!options.allowOtherWorktree) {
			const mismatch = identityMismatch(
				task,
				workspaceId,
				ctx.worktreePath,
				branchOf(ctx.worktreePath),
			);
			if (mismatch)
				throw new TRPCError({ code: "CONFLICT", message: mismatch });
		}
		return { ctx, task };
	}

	const taskInput = z.object({ workspaceId: z.string(), slug: z.string() });

	/** A task whose history may change: not while a run is using it. */
	function historyTask(workspaceId: string, slug: string) {
		const found = taskFor(workspaceId, slug);
		if (activeRun(found.task)) {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Wait for the current run to finish before changing its history",
			});
		}
		return found;
	}

	return router({
		getSettings: publicProcedure.query(() => ({
			settings: loadWorkflowSettings(deps.homeDir()),
			defaults: defaultWorkflowSettings(),
		})),

		setSettings: publicProcedure
			.input(settingsInputSchema)
			.mutation(({ input }) => {
				const home = deps.homeDir();
				const current = loadWorkflowSettings(home);
				const result = validateWorkflowSettings({
					...input,
					execution: input.execution ?? current.execution,
					version: 1,
				});
				if (!result.ok) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: result.errors.join("; "),
					});
				}
				saveWorkflowSettings(home, result.settings);
				// Every project's roles file follows the new routing.
				const projectsUpdated = refreshAllProjectWorkflows(home);
				return { settings: result.settings, projectsUpdated };
			}),

		/**
		 * Interactive sessions recorded from transcripts: API-equivalent
		 * estimates (on a subscription they are not charges). Unpriced
		 * responses are counted so the total is never shown as complete when
		 * it is not.
		 */
		getUsageSummary: publicProcedure.query(() => {
			const sessions = loadSessions(getMetricsDir());
			const owned = dedupeAcrossSessions(sessions);
			const today = localDay(new Date());
			const all = [...owned.values()].flat();
			const todays = all.filter((record) => {
				const at = new Date(record.timestamp);
				return !Number.isNaN(at.getTime()) && localDay(at) === today;
			});
			const allCost = costOf(all);
			const todayCost = costOf(todays);
			return {
				sessions: sessions.length,
				todayUsd: todayCost.usd,
				todayUnpriced: todayCost.unpricedMessages,
				allTimeUsd: allCost.usd,
				allTimeUnpriced: allCost.unpricedMessages,
			};
		}),

		/** The Tasks panel: this workspace's project, its tasks and spend. */
		getProjectTasks: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				const ctx = deps.resolveWorkspace(input.workspaceId);
				const { project } = ctx;
				const settings = loadWorkflowSettings(deps.homeDir());
				const projectChecks = loadProjectChecks(project);
				const states = new Map<string, string | undefined>();
				const probes: Probes = {
					branchNow: branchOf(ctx.worktreePath),
					codeStateOf: (worktree) => {
						if (!states.has(worktree))
							states.set(worktree, codeStateOf(worktree));
						return states.get(worktree);
					},
				};
				const tasks = listTaskRecords(project).map((task) =>
					describeTask(
						deps.homeDir(),
						project,
						task,
						ctx,
						settings,
						{
							commands: effectiveChecks(
								project,
								task.identity.worktreePath,
								settings.execution.autoChecks ?? true,
							).commands,
						},
						probes,
					),
				);

				// Task runs: Claude Code's reported cost (each run once, child
				// subagents included). Interactive sessions in this project:
				// estimated from transcripts, kept separate.
				const taskTotals = tasks.reduce(
					(sum, task) => ({
						usd: sum.usd + task.spend.usd,
						worstCaseUsd: sum.worstCaseUsd + task.spend.worstCaseUsd,
						pendingRuns: sum.pendingRuns + task.spend.pendingRuns,
						unknownRuns: sum.unknownRuns + task.spend.unknownRuns,
						partialRuns: sum.partialRuns + task.spend.partialRuns,
						uncertainRuns: sum.uncertainRuns + task.spend.uncertainRuns,
					}),
					{
						usd: 0,
						worstCaseUsd: 0,
						pendingRuns: 0,
						unknownRuns: 0,
						partialRuns: 0,
						uncertainRuns: 0,
					},
				);
				// Task runs' transcripts are recorded too (for reports); here they
				// are already counted from task.json, so leave them out.
				const runSessions = new Set(
					tasks.flatMap((task) => task.runs.map((run) => run.sessionId)),
				);
				const sessions = loadSessions(getMetricsDir()).filter(
					(session) =>
						session.projectKey === project.key &&
						!runSessions.has(session.sessionId),
				);
				const owned = dedupeAcrossSessions(sessions);
				const sessionCost = costOf([...owned.values()].flat());

				return {
					project: {
						key: project.key,
						name: project.name,
						root: project.root,
						tasksDir: project.tasksDir,
					},
					worktreePath: ctx.worktreePath,
					/** Imported conversations a new task here would search. */
					historyAvailable: eligibleConversations(project, ctx.worktreePath)
						.length,
					runtime: ctx.runtime,
					/** Managed stages always run on Claude Code, even in Codex workspaces. */
					executor: "claude-code" as const,
					permissions: settings.execution.permissions,
					checks: {
						commands: projectChecks.commands,
						approved: !!projectChecks.approvedAt,
					},
					tasks,
					usage: {
						tasks: taskTotals,
						sessions: {
							count: sessions.length,
							usd: sessionCost.usd,
							unpricedMessages: sessionCost.unpricedMessages,
						},
					},
				};
			}),

		/** Pushes a refresh signal when any task changes. */
		onTaskChanged: publicProcedure.subscription(() =>
			observable<TaskChangeEvent>((emit) => {
				const handler = (event: TaskChangeEvent) => emit.next(event);
				deps.events.on("task-changed", handler);
				return () => {
					deps.events.off("task-changed", handler);
				};
			}),
		),

		/** Preview how a description would be routed, before creating it. */
		classify: publicProcedure
			.input(z.object({ description: z.string().max(20_000) }))
			.query(({ input }) => {
				const decision = classifyTask(input.description);
				const settings = loadWorkflowSettings(deps.homeDir());
				const firstStage = decision.route === "plan" ? "plan" : decision.route;
				return {
					...decision,
					model: stageModel(firstStage, decision, settings),
				};
			}),

		/** The project's check commands: saved, approved, and suggestions. */
		getChecks: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				const ctx = deps.resolveWorkspace(input.workspaceId);
				const checks = loadProjectChecks(ctx.project);
				const settings = loadWorkflowSettings(deps.homeDir());
				const effective = effectiveChecks(
					ctx.project,
					ctx.worktreePath,
					settings.execution.autoChecks ?? true,
				);
				return {
					commands: checks.commands,
					approved: !!checks.approvedAt,
					suggestions: suggestChecks(ctx.worktreePath),
					/** What Auto verifies with now: saved, the project's own, or none. */
					effective,
				};
			}),

		/**
		 * Commands this project's implementing runs may execute (setup,
		 * installs), approved one by one. Separate from the checks, which ADE
		 * runs itself to verify work.
		 */
		getCommandApprovals: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				const ctx = deps.resolveWorkspace(input.workspaceId);
				const settings = loadWorkflowSettings(deps.homeDir());
				return {
					approvals: loadCommandApprovals(ctx.project).map((a) => ({
						...a,
						rule: approvalRule(a),
					})),
					/** "edits": agents may not run commands at all (Settings). */
					commandsAllowed: settings.execution.permissions !== "edits",
					/** Installing and the project's own scripts, without asking. */
					projectCommands: projectCommandsEnabled(ctx.project),
					/** What that allows in this workspace now. */
					projectCommandList: projectCommands(ctx.worktreePath),
				};
			}),

		/** Approve one command (exactly, or with extra arguments where safe). */
		approveCommand: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					tool: z.enum(["Bash", "PowerShell"]),
					command: z.string().min(1).max(300),
					match: z.enum(["exact", "prefix"]).default("exact"),
					cwd: z.string().max(1000).optional(),
					slug: z.string().optional(),
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const approval = addCommandApproval(ctx.project, {
						tool: input.tool,
						command: input.command,
						match: input.match,
						cwd: input.cwd,
						fromTask: input.slug,
					});
					deps.events.emit("task-changed", {
						projectKey: ctx.project.key,
						slug: input.slug ?? "",
					});
					return { ...approval, rule: approvalRule(approval) };
				}),
			),

		/** Why a command could not be approved, before the user submits it. */
		checkCommandApproval: publicProcedure
			.input(
				z.object({
					tool: z.string(),
					command: z.string().max(1000),
					match: z.enum(["exact", "prefix"]),
				}),
			)
			.query(({ input }) => ({
				problem: approvalProblem(input) ?? null,
				rule: approvalProblem(input)
					? null
					: approvalRule(input as Parameters<typeof approvalRule>[0]),
			})),

		/** Turn "project commands" on or off for the project. */
		setProjectCommands: publicProcedure
			.input(z.object({ workspaceId: z.string(), enabled: z.boolean() }))
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					setProjectCommands(ctx.project, input.enabled);
					return { enabled: input.enabled };
				}),
			),

		removeCommandApproval: publicProcedure
			.input(z.object({ workspaceId: z.string(), id: z.string() }))
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					removeCommandApproval(ctx.project, input.id);
					return { ok: true };
				}),
			),

		/** Save and approve the commands ADE runs to verify every task. */
		setChecks: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					commands: z.array(z.string()).max(10),
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const saved = saveProjectChecks(ctx.project, input.commands);
					return { commands: saved.commands, approved: !!saved.approvedAt };
				}),
			),

		/**
		 * One request in, one task out. In Auto mode ADE starts it at once and
		 * keeps going to a verified finish; in Manual mode it waits for steps.
		 * The result carries the task's state, so a failed launch is visible.
		 */
		createTask: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					description: z.string().min(1).max(20_000),
					route: z.enum(TASK_ROUTES).optional(),
					mode: z.enum(["auto", "manual"]).default("auto"),
					/** Give the task excerpts of the project's imported history. */
					useHistory: z.boolean().default(true),
					/** Let a short AI run choose the pathway and models (Auto only). */
					aiRouting: z.boolean().default(false),
					/**
					 * Research with the Researcher (web search): "auto" when the request
					 * asks for it (or the pathway choice does), "first", or "only" (no
					 * code changes), or "none".
					 */
					research: z.enum(["auto", "first", "only", "none"]).default("auto"),
					/** Attachments added in the composer (their ids). */
					attachments: z.array(z.string()).max(10).default([]),
					/** A team request: a Coordinator splits it across the specialists (Auto only). */
					split: z.boolean().default(false),
					/** "auto": ADE picks from the team's specialists; "none": default workflow. */
					specialist: z.string().default("auto"),
					/** Model settings for this task only. */
					roleOverrides: roleOverridesSchema.optional(),
				}),
			)
			.mutation(({ input }) =>
				guarded(async () => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const execution = loadWorkflowSettings(deps.homeDir()).execution;
					const created = createTask(ctx.project, {
						description: input.description,
						route: input.route,
						mode: input.mode,
						identity: deps.captureIdentity(input.workspaceId, ctx.worktreePath),
						limits: {
							budgetUsd: execution.taskBudgetUsd,
							maxCorrections: execution.maxCorrections,
							maxReviewRounds: execution.maxReviewRounds,
							maxEscalations: execution.maxEscalations,
						},
					});
					const withSpecialist = assignSpecialist(
						deps.homeDir(),
						ctx.project,
						created,
						input.specialist,
						input.roleOverrides,
						input.workspaceId,
					);
					const routed: TaskRecord =
						input.split && input.mode === "auto"
							? {
									...created,
									isRequest: true,
									teamAgents: deps.listAgents?.(input.workspaceId) ?? [],
									routeBy: "ai",
									routeReasons: ["a team request: the Coordinator splits it"],
									specialistReason:
										"the Coordinator assigns a specialist to each subtask",
								}
							: input.aiRouting && input.mode === "auto" && !input.route
								? { ...withSpecialist, routeBy: "ai" }
								: {
										...withSpecialist,
										routeBy: input.route ? "user" : "rules",
									};
					const research =
						input.research === "first" || input.research === "only"
							? input.research
							: input.research === "auto" &&
									(asksForResearch(input.description) ||
										listSpecialists(ctx.project).find(
											(sp) => sp.id === routed.specialistId,
										)?.templateId === RESEARCH_TEMPLATE_ID)
								? "first"
								: undefined;
					if (research) routed.research = research;
					const attached = resolveAttachments(
						deps.homeDir(),
						ctx.project.key,
						input.attachments,
					);
					if (attached.length) routed.attachments = attached;
					saveTask(ctx.project, routed);
					const task = input.useHistory
						? withHistory(ctx.project, routed, [])
						: routed;
					const started =
						input.mode === "auto"
							? await deps.controller().start(ctx.project, task.slug)
							: task;
					return {
						slug: started.slug,
						route: started.route,
						mode: started.mode,
						state: started.state,
						stateReason: started.stateReason ?? null,
					};
				}),
			),

		/**
		 * Choose the task's history again from the project's current imports
		 * (after importing, refreshing or removing conversations).
		 */
		refreshTaskHistory: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(() => {
				const { ctx, task } = historyTask(input.workspaceId, input.slug);
				const updated = withHistory(
					ctx.project,
					task,
					task.history?.excluded ?? [],
				);
				return { excerpts: updated.history?.excerpts ?? 0 };
			}),
		),

		/** Stop using one conversation in this task (the import is kept). */
		excludeTaskHistory: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					slug: z.string(),
					conversationId: z.string(),
				}),
			)
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx, task } = historyTask(input.workspaceId, input.slug);
					const excluded = [
						...new Set([
							...(task.history?.excluded ?? []),
							input.conversationId,
						]),
					];
					const updated = withHistory(ctx.project, task, excluded);
					return { excerpts: updated.history?.excerpts ?? 0 };
				}),
			),

		/** Run this task without any project history. */
		clearTaskHistory: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(() => {
				const { ctx, task } = historyTask(input.workspaceId, input.slug);
				clearTaskHistory(taskDir(ctx.project, task.slug));
				const { history: _history, ...rest } = task;
				saveTask(ctx.project, rest);
				return { cleared: true };
			}),
		),

		/** Manual: choose the task's specialist (not while a run is going). */
		setTaskSpecialist: publicProcedure
			.input(taskInput.extend({ specialist: z.string() }))
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx, task } = historyTask(input.workspaceId, input.slug);
					const updated = assignSpecialist(
						deps.homeDir(),
						ctx.project,
						{
							...task,
							specialistId: undefined,
							supportingSpecialistIds: [],
						},
						input.specialist,
						task.roleOverrides,
					);
					return { specialistId: updated.specialistId ?? null };
				}),
			),

		/** This task's own role settings (they never change saved settings). */
		setTaskRoleOverrides: publicProcedure
			.input(taskInput.extend({ roleOverrides: roleOverridesSchema }))
			.mutation(({ input }) =>
				guarded(() => {
					const { ctx, task } = historyTask(input.workspaceId, input.slug);
					saveTask(ctx.project, {
						...task,
						roleOverrides: input.roleOverrides as TaskRecord["roleOverrides"],
					});
					return { ok: true };
				}),
			),

		start: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug);
				const task = await deps.controller().start(ctx.project, input.slug);
				return { state: task.state, stateReason: task.stateReason ?? null };
			}),
		),

		/**
		 * What this workspace's agent is doing: the task running here now
		 * (step, model, elapsed, cost, its latest message), what waits for the
		 * user, and what it did recently. Its own tasks only.
		 */
		agentActivity: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				const ctx = deps.resolveWorkspace(input.workspaceId);
				const mine = listTaskRecords(ctx.project).filter(
					(task) =>
						!task.isRequest && task.identity.workspaceId === input.workspaceId,
				);
				const lastAt = (task: TaskRecord) =>
					task.runs.reduce(
						(at, run) =>
							(run.endedAt ?? run.startedAt ?? "") > at
								? (run.endedAt ?? run.startedAt ?? "")
								: at,
						task.createdAt,
					);
				const runningTask = mine.find((task) => activeRun(task));
				const run = runningTask ? activeRun(runningTask) : undefined;
				return {
					current:
						runningTask && run
							? {
									slug: runningTask.slug,
									title: runningTask.title,
									kind: run.kind,
									role: run.role ?? null,
									model: run.model ?? null,
									startedAt: run.startedAt ?? run.queuedAt,
									costUsd: run.liveCostUsd ?? 0,
									lastText: run.lastText ?? null,
									responses: run.responses ?? 0,
									step: runningTask.runs.length,
								}
							: null,
					waiting: mine
						.filter(
							(task) =>
								!task.waitingForFolder &&
								["paused", "blocked", "needs-input", "failed"].includes(
									task.state,
								),
						)
						.map((task) => ({
							slug: task.slug,
							title: task.title,
							state: task.state,
							reason: task.stateReason ?? null,
						})),
					queued: mine.filter((task) => task.waitingForFolder).length,
					recent: [...mine]
						.filter((task) => task.runs.length > 0 && task !== runningTask)
						.sort((a, b) => lastAt(b).localeCompare(lastAt(a)))
						.slice(0, 8)
						.map((task) => ({
							slug: task.slug,
							title: task.title,
							state: task.state,
							reason: task.stateReason ?? null,
							at: lastAt(task),
							costUsd: taskSpend(task).usd,
							runs: task.runs.length,
						})),
				};
			}),

		/** Top-level tasks and team requests that are waiting for the user. */
		attention: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }) => {
				const ctx = deps.resolveWorkspace(input.workspaceId);
				return listTaskRecords(ctx.project)
					.filter(
						(task) =>
							!task.parentSlug &&
							!task.waitingForFolder &&
							["paused", "blocked", "needs-input", "failed"].includes(
								task.state,
							),
					)
					.map((task) => ({
						slug: task.slug,
						title: task.title,
						state: task.state,
						reason: task.stateReason ?? null,
					}));
			}),

		/**
		 * Resume everything that is waiting, at once. What still needs a
		 * decision (an answer, a command approval) stays, with its reason.
		 */
		resumeAll: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.mutation(({ input }) =>
				guarded(async () => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const waiting = listTaskRecords(ctx.project).filter(
						(task) =>
							!task.parentSlug &&
							["paused", "blocked", "needs-input", "failed"].includes(
								task.state,
							),
					);
					let resumed = 0;
					const still: Array<{ title: string; reason: string }> = [];
					for (const task of waiting) {
						const files = readTaskFiles(ctx.project, task.slug);
						if (task.state === "needs-input" && files.planQuestions.length) {
							still.push({
								title: task.title,
								reason: "The plan has questions for you.",
							});
							continue;
						}
						try {
							const after = await deps
								.controller()
								.resume(ctx.project, task.slug);
							// Queued behind another task in its folder: it will run.
							if (
								!after.waitingForFolder &&
								["paused", "blocked", "needs-input", "failed"].includes(
									after.state,
								)
							) {
								still.push({
									title: task.title,
									reason: after.stateReason ?? after.state,
								});
							} else {
								resumed++;
							}
						} catch (error) {
							still.push({
								title: task.title,
								reason: error instanceof Error ? error.message : String(error),
							});
						}
					}
					return { resumed, still };
				}),
			),

		resume: publicProcedure
			.input(
				taskInput.extend({
					/** Retry a permission-blocked step although nothing new was approved. */
					retryWithoutApproval: z.boolean().optional(),
				}),
			)
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug);
					const task = await deps.controller().resume(ctx.project, input.slug, {
						retryWithoutApproval: input.retryWithoutApproval,
					});
					return { state: task.state, stateReason: task.stateReason ?? null };
				}),
			),

		/** Pause and Cancel always work, from any worktree of the project. */
		/** Accept a stopped task's work as it is, so what builds on it can start. */
		accept: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug, {
					allowOtherWorktree: true,
				});
				const task = await deps.controller().accept(ctx.project, input.slug);
				return { state: task.state, stateReason: task.stateReason ?? null };
			}),
		),

		/** Notes for a task that has not finished; later runs read them. */
		addNotes: publicProcedure
			.input(taskInput.extend({ notes: z.string().min(1).max(10_000) }))
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug, {
						allowOtherWorktree: true,
					});
					const task = await deps
						.controller()
						.addNotes(ctx.project, input.slug, input.notes);
					return { notes: task.notes ?? [] };
				}),
			),

		pause: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug, {
					allowOtherWorktree: true,
				});
				const task = await deps.controller().pause(ctx.project, input.slug);
				return { state: task.state, stateReason: task.stateReason ?? null };
			}),
		),

		cancel: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug, {
					allowOtherWorktree: true,
				});
				const task = await deps.controller().cancel(ctx.project, input.slug);
				return { state: task.state, stateReason: task.stateReason ?? null };
			}),
		),

		setMode: publicProcedure
			.input(taskInput.extend({ mode: z.enum(["auto", "manual"]) }))
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug);
					const task = await deps
						.controller()
						.setMode(ctx.project, input.slug, input.mode);
					return { mode: task.mode, state: task.state };
				}),
			),

		answer: publicProcedure
			.input(taskInput.extend({ answers: z.string().min(1).max(10_000) }))
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug);
					const task = await deps
						.controller()
						.answer(ctx.project, input.slug, input.answers);
					return { state: task.state, stateReason: task.stateReason ?? null };
				}),
			),

		/**
		 * Team chat: start a conversation with the Coordinator. It replies
		 * (a short read-only run), the plan is agreed in the conversation, and
		 * nothing is built until the user says Go.
		 */
		startChat: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					message: z.string().trim().min(1).max(20_000),
					attachments: z.array(z.string()).max(10).default([]),
				}),
			)
			.mutation(({ input }) =>
				guarded(async () => {
					const ctx = deps.resolveWorkspace(input.workspaceId);
					const execution = loadWorkflowSettings(deps.homeDir()).execution;
					const created = createTask(ctx.project, {
						description: input.message,
						mode: "auto",
						identity: deps.captureIdentity(input.workspaceId, ctx.worktreePath),
						limits: {
							budgetUsd: execution.taskBudgetUsd,
							maxCorrections: execution.maxCorrections,
							maxReviewRounds: execution.maxReviewRounds,
							maxEscalations: execution.maxEscalations,
						},
					});
					const attached = resolveAttachments(
						deps.homeDir(),
						ctx.project.key,
						input.attachments,
					);
					const chat: TaskRecord = {
						...created,
						...(attached.length ? { attachments: attached } : {}),
						isRequest: true,
						chat: [
							{
								role: "user",
								text: attached.length
									? `${input.message}\n\n(Attached: ${attached.map((a) => a.name).join(", ")})`
									: input.message,
								at: new Date().toISOString(),
							},
						],
						teamAgents: deps.listAgents?.(input.workspaceId) ?? [],
						routeBy: "ai",
						routeReasons: ["a team chat: planned with the Coordinator"],
						specialistReason:
							"the Coordinator assigns a specialist to each subtask",
					};
					saveTask(ctx.project, chat);
					const started = await deps.controller().start(ctx.project, chat.slug);
					return {
						slug: started.slug,
						state: started.state,
						stateReason: started.stateReason ?? null,
					};
				}),
			),

		/** Team chat: the user's next message ("go" starts the plan). */
		chatSay: publicProcedure
			.input(
				taskInput.extend({
					message: z.string().trim().min(1).max(20_000),
					attachments: z.array(z.string()).max(10).default([]),
				}),
			)
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug, {
						allowOtherWorktree: true,
					});
					const task = await deps
						.controller()
						.chatSay(
							ctx.project,
							input.slug,
							input.message,
							resolveAttachments(
								deps.homeDir(),
								ctx.project.key,
								input.attachments,
							),
						);
					return { state: task.state, stateReason: task.stateReason ?? null };
				}),
			),

		/**
		 * The Team chat tab: for a team's own workspace, the command that starts
		 * Claude Code as the Coordinator (with the team's MCP server).
		 */
		teamChatLaunch: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(async ({ input }) => {
				const workspace = localDb
					.select()
					.from(workspaces)
					.where(eq(workspaces.id, input.workspaceId))
					.get();
				const worktreePath = workspace ? getWorkspacePath(workspace) : null;
				if (!workspace || workspace.type !== "branch" || !worktreePath) {
					return { enabled: false as const };
				}
				const {
					teamChatCommand,
					teamChatSession,
					writeTeamMcpConfig,
					TEAM_CHAT_TAB,
				} = await import("./team-mcp");
				const config = writeTeamMcpConfig(
					deps.homeDir(),
					input.workspaceId,
					env.DESKTOP_NOTIFICATIONS_PORT,
				);
				return {
					enabled: true as const,
					tabName: TEAM_CHAT_TAB,
					cwd: worktreePath,
					// The last Team chat conversation continues (when it still exists).
					command: teamChatCommand(
						config,
						teamChatSession(deps.homeDir(), input.workspaceId, worktreePath),
					),
				};
			}),

		/** Team chat: Go, start the latest plan. */
		chatGo: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug, {
					allowOtherWorktree: true,
				});
				const task = await deps
					.controller()
					.approvePlan(ctx.project, input.slug);
				return { state: task.state, stateReason: task.stateReason ?? null };
			}),
		),

		setBudget: publicProcedure
			.input(taskInput.extend({ budgetUsd: z.number().positive().max(10_000) }))
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug, {
						allowOtherWorktree: true,
					});
					const task = await deps
						.controller()
						.setLimits(ctx.project, input.slug, { budgetUsd: input.budgetUsd });
					return { limits: task.limits };
				}),
			),

		/** Manual mode (or a paused Auto task): run one step. */
		runStep: publicProcedure
			.input(
				taskInput.extend({
					kind: z.enum(RUN_KINDS),
					model: z.string().max(100).optional(),
					customRoleId: z.string().max(100).optional(),
				}),
			)
			.mutation(({ input }) =>
				guarded(async () => {
					const { ctx } = taskFor(input.workspaceId, input.slug);
					const task = await deps
						.controller()
						.runStep(
							ctx.project,
							input.slug,
							input.kind,
							input.model,
							input.customRoleId,
						);
					return { state: task.state, stateReason: task.stateReason ?? null };
				}),
			),

		/** Explicitly move a task from another worktree to this one. */
		moveHere: publicProcedure.input(taskInput).mutation(({ input }) =>
			guarded(async () => {
				const { ctx } = taskFor(input.workspaceId, input.slug, {
					allowOtherWorktree: true,
				});
				const task = await deps
					.controller()
					.adopt(
						ctx.project,
						input.slug,
						deps.captureIdentity(input.workspaceId, ctx.worktreePath),
					);
				return { worktreePath: task.identity.worktreePath };
			}),
		),

		/**
		 * The command to open a run's Claude session in a terminal of the task's
		 * worktree. Interactive: ADE's permissions, budget and turn limits do not
		 * apply there (the panel says so).
		 */
		sessionCommand: publicProcedure
			.input(taskInput.extend({ runId: z.string() }))
			.query(({ input }) => {
				const { task } = taskFor(input.workspaceId, input.slug);
				const run = task.runs.find((r) => r.id === input.runId);
				if (!run?.sessionId) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "This run has no session",
					});
				}
				return {
					command: buildResumeCommand(run.sessionId),
					cwd: task.identity.worktreePath,
				};
			}),
	});
};
