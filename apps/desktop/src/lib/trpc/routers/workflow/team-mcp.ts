import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getClaudeSettingsContent } from "main/lib/agent-setup/agent-wrappers-claude-codex";
import { getNotifyScriptPath } from "main/lib/agent-setup/notify-hook";
import {
	createTask,
	getTask,
	listSpecialists,
	listTaskRecords,
	loadWorkflowSettings,
	resolveSpecialist,
	saveTask,
	type TaskRecord,
	taskSpend,
	withTaskLock,
} from "main/lib/agent-workflow";
import { parseSplit } from "main/lib/agent-workflow/split";
import { PLANNING_PRINCIPLES } from "main/lib/agent-workflow/stage-prompts";
import { getLocalToken } from "main/lib/notifications/local-auth";
import { transcriptPathFor } from "main/lib/usage-metrics/transcript";
import { defaultWorkflowRouterDeps, type WorkflowRouterDeps } from "./workflow";

/**
 * The team chat as a Claude Code session. ADE starts `claude` in the team's
 * folder with this MCP server (served by ADE's local HTTP server, 127.0.0.1
 * only, behind the "team" token that only the session's MCP config file
 * holds). The server's instructions make the session the team's
 * Coordinator: it talks the work through with the user, reads the code
 * without editing, and when the user says go, hands the agreed plan to ADE
 * with start_plan. ADE then runs it as a team request: each subtask on its
 * specialist's agent, with checks and review.
 */

export const TEAM_MCP_NAME = "ade-team";
export const TEAM_CHAT_TAB = "Team chat";

const INSTRUCTIONS = `You are the Coordinator of this ADE team. The user talks with you here to plan work; the team's agents do it after the user says go.

- At the start of a conversation call team_overview once, to learn the team's specialists and which agent does each.
- Talk in short, plain sentences. Read the code only as much as you need to plan well; never edit files or build the work yourself.
- If something important is unclear (what they want, where it belongs, a choice only they can make), ask at most two short questions before planning.
- How to split work:
${PLANNING_PRINCIPLES}
- Propose a plan as a numbered list. For each subtask: a short title, what to change and how to know it is done, the specialist (by name, or "none"), the route ("quick", "implement", "plan" or "exceptional"), the model per role, and which earlier subtasks it waits for. Independent subtasks run at the same time on their agents. Revise the plan whenever the user asks.
- Models, as cheaply as is reliable: haiku only for trivial low-risk work, sonnet for normal work, opus for planning or reviewing difficult or risky work, fable only for exceptional architecture. Risky work (authentication, permissions, secrets, payments, data migrations, messaging people) is never "quick".
- Only when the user clearly says to start (for example "go"), call start_plan with their request and the exact plan you agreed. Then say it has started, and use plan_status when they ask how it is going.
- When a started plan has stopped, call resume_plan yourself instead of asking the user to click Resume, unless they said to wait. Tell them in one sentence what stopped it and that you resumed it. If resume_plan says only the user can settle something (approving a command, answering questions, raising a budget, a stop that keeps repeating), tell them exactly what to do in ADE.`;

const TOOLS = [
	{
		name: "team_overview",
		description:
			"The team's repository, its specialists (with the agent that does each, and their role models) and its latest team plans. Read-only.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "start_plan",
		description:
			"Start the agreed plan: ADE creates one task per subtask, on the specialist's agent, and runs them (independent ones at the same time) with checks and review. This spends money on model runs. Call it only after the user has clearly said to start.",
		inputSchema: {
			type: "object",
			required: ["request", "plan"],
			properties: {
				request: {
					type: "string",
					description: "What the user asked for, in one or two sentences.",
				},
				plan: {
					type: "object",
					required: ["subtasks", "reason"],
					properties: {
						reason: {
							type: "string",
							description: "Why it is split this way, in one sentence.",
						},
						subtasks: {
							type: "array",
							minItems: 1,
							maxItems: 6,
							items: {
								type: "object",
								required: ["title", "description", "route"],
								properties: {
									title: { type: "string" },
									description: {
										type: "string",
										description:
											"What to change, the interfaces it uses or provides, and how to know it is done.",
									},
									specialist: {
										type: "string",
										description:
											'A specialist\'s name from team_overview, or "none".',
									},
									route: {
										type: "string",
										enum: ["quick", "implement", "plan", "exceptional"],
									},
									models: {
										type: "object",
										description:
											'Model per role, e.g. {"planner": "opus", "implementer": "sonnet", "reviewer": "sonnet"}.',
									},
									dependsOn: {
										type: "array",
										items: { type: "integer" },
										description:
											"Numbers (from 1) of earlier subtasks whose work this one needs; [] if none.",
									},
								},
							},
						},
					},
				},
			},
		},
	},
	{
		name: "plan_status",
		description:
			"How a started plan is going: each subtask's agent, state and reason. Without an id, the latest plan. Read-only.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "The plan id start_plan returned." },
			},
		},
	},
	{
		name: "resume_plan",
		description:
			"Resume a started plan whose subtasks stopped, as the user's Resume button in ADE does. Without an id, the latest plan. It continues model runs, which use the user's Claude usage. It does not resume what only the user can settle (a command waiting for approval, questions for the user, a used-up budget, a pause they asked for, or a subtask that stopped the same way right after the last resume); it says what the user needs to do instead.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "The plan id start_plan returned." },
				userAskedToResume: {
					type: "boolean",
					description:
						"True only when the user, in this conversation, asked to resume a plan they had paused themselves.",
				},
			},
		},
	},
] as const;

/** Subtask states that wait for a Resume. */
const STOPPED = ["paused", "blocked", "failed", "needs-input"];
/** Stops ADE gets past by itself (a rate-limit wait, a restart). */
const ADE_CONTINUES = /tries again in|continues on its own|starts by itself/i;
/** Pauses the user asked for. */
const USER_PAUSED = /^Paused\.$|^Pausing after/i;
/** Resumes from the Team chat per plan; after that, Resume is the user's. */
const MAX_COORDINATOR_RESUMES = 10;

function writePrivate(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort (no-op on Windows, where the profile folder is private).
	}
}

/** Where a team's Coordinator settings live, next to its MCP config. */
function settingsPathFor(configPath: string): string {
	return configPath.replace(/\.mcp\.json$/, ".settings.json");
}

/**
 * The files the Coordinator session is started with (0600): its MCP config
 * (the team server, with the token) and its settings (the Coordinator plans;
 * the agents do the work, so it may not edit files). Returns the MCP config.
 */
export function writeTeamMcpConfig(
	homeDir: string,
	workspaceId: string,
	port: number,
	/** More servers for the Coordinator (Vercel), with tools it may use freely. */
	extra?: { servers: Record<string, unknown>; allow: string[] },
): string {
	const dir = join(homeDir, "team-chat");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${workspaceId}.mcp.json`);
	const config = {
		mcpServers: {
			[TEAM_MCP_NAME]: {
				type: "http",
				url: `http://127.0.0.1:${port}/team-mcp/${encodeURIComponent(workspaceId)}`,
				headers: {
					Authorization: `Bearer ${getLocalToken(homeDir, "team")}`,
				},
			},
			...extra?.servers,
		},
	};
	writePrivate(path, config);
	writePrivate(settingsPathFor(path), {
		// ADE's own hooks (notifications, usage), as in the claude wrapper's
		// --settings: kept whether Claude Code merges both files or keeps one.
		...JSON.parse(getClaudeSettingsContent(getNotifyScriptPath())),
		permissions: {
			allow: [
				`mcp__${TEAM_MCP_NAME}__team_overview`,
				`mcp__${TEAM_MCP_NAME}__plan_status`,
				// The user asked for the Coordinator to resume without a click;
				// resume_plan itself refuses what only the user can settle.
				`mcp__${TEAM_MCP_NAME}__resume_plan`,
				...(extra?.allow ?? []),
			],
			deny: ["Edit", "Write", "NotebookEdit"],
		},
	});
	return path;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Team chat's own Claude Code conversation, kept per team workspace so
 * it continues where it left off: resumed while its transcript exists,
 * otherwise started with a new id that is recorded here.
 */
export function teamChatSession(
	homeDir: string,
	workspaceId: string,
	cwd: string,
): { resume?: string; sessionId?: string } {
	const path = join(homeDir, "team-chat", `${workspaceId}.session.json`);
	try {
		const saved = JSON.parse(readFileSync(path, "utf8")) as {
			sessionId?: string;
		};
		if (saved.sessionId && UUID.test(saved.sessionId)) {
			// A conversation with messages is resumed; one never used yet
			// (no transcript) starts again under the same id.
			return existsSync(transcriptPathFor(cwd, saved.sessionId))
				? { resume: saved.sessionId }
				: { sessionId: saved.sessionId };
		}
	} catch {
		// No conversation yet.
	}
	const sessionId = randomUUID();
	mkdirSync(join(homeDir, "team-chat"), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ sessionId }, null, 2)}\n`, "utf8");
	return { sessionId };
}

/** The command that starts the Coordinator session in a terminal. */
export function teamChatCommand(
	configPath: string,
	session: { resume?: string; sessionId?: string } = {},
): string {
	const config = configPath.replace(/\\/g, "/");
	// Kept short: it is what the user sees typed into the terminal. The
	// permissions are in the settings file, the role in the server's
	// instructions.
	return [
		"claude",
		// The same conversation as last time, or a new one with a known id.
		session.resume
			? `--resume ${session.resume}`
			: `-n "${TEAM_CHAT_TAB}"${session.sessionId ? ` --session-id ${session.sessionId}` : ""}`,
		// The Coordinator plans: Opus, like the planner.
		"--model opus --effort high",
		`--mcp-config "${config}"`,
		`--settings "${settingsPathFor(config)}"`,
		`--append-system-prompt "You are this ADE team's Coordinator: follow the ${TEAM_MCP_NAME} instructions."`,
	].join(" ");
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: string;
	params?: Record<string, unknown>;
}

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function text(value: string, isError = false) {
	return {
		content: [{ type: "text", text: value }],
		...(isError ? { isError } : {}),
	};
}

function teamRequests(tasks: TaskRecord[]): TaskRecord[] {
	return tasks
		.filter((t) => t.isRequest)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function describePlan(request: TaskRecord, all: TaskRecord[]): string {
	const subtasks = (request.subtaskSlugs ?? []).map((slug) =>
		all.find((t) => t.slug === slug),
	);
	const lines = subtasks.map((sub, i) =>
		sub
			? `${i + 1}. ${sub.title} — ${sub.agentName ? `${sub.agentName}, ` : ""}${sub.state}${sub.stateReason && sub.state !== "done" ? ` (${sub.stateReason})` : ""}`
			: `${i + 1}. (missing)`,
	);
	return [
		`Plan ${request.slug}: "${request.title}" — ${request.state}${request.stateReason ? `: ${request.stateReason}` : ""}`,
		...lines,
	].join("\n");
}

export function createTeamMcpHandler(
	deps: WorkflowRouterDeps = defaultWorkflowRouterDeps,
) {
	const overview = (workspaceId: string): string => {
		const ctx = deps.resolveWorkspace(workspaceId);
		const home = deps.homeDir();
		const settings = loadWorkflowSettings(home);
		const agents = deps.listAgents?.(workspaceId) ?? [];
		const specialists = listSpecialists(ctx.project).map((s) => {
			const resolved = resolveSpecialist(s, settings, home);
			const agent = agents.find((a) => a.workspaceId === s.agentWorkspaceId);
			const roles = Object.values(resolved.roles)
				.map((r) => `${r.label} ${r.model}/${r.effort}`)
				.join(", ");
			return `- "${s.name}" (${s.specialty})${agent ? `, done by the agent "${agent.name}"` : ", no agent (runs in the team's folder)"}. Roles: ${roles}`;
		});
		const plans = teamRequests(listTaskRecords(ctx.project))
			.slice(0, 5)
			.map((t) => `- ${t.slug}: "${t.title}" — ${t.state}`);
		return [
			`Team "${ctx.project.name}", repository ${ctx.project.root}.`,
			"",
			"Specialists:",
			...(specialists.length
				? specialists
				: ["- none: every subtask uses the default workflow"]),
			"",
			`Agents: ${agents.map((a) => a.name).join(", ") || "none"}.`,
			"",
			"Latest plans:",
			...(plans.length ? plans : ["- none yet"]),
		].join("\n");
	};

	const startPlan = async (
		workspaceId: string,
		args: Record<string, unknown>,
	): Promise<ReturnType<typeof text>> => {
		const request = typeof args.request === "string" ? args.request.trim() : "";
		if (!request) return text("start_plan needs the user's request.", true);
		const plan = parseSplit(
			`\`\`\`json\n${JSON.stringify(args.plan ?? {})}\n\`\`\``,
		);
		if (!plan) {
			return text(
				"The plan could not be read: it needs subtasks, each with a title and a description.",
				true,
			);
		}
		const ctx = deps.resolveWorkspace(workspaceId);
		const execution = loadWorkflowSettings(deps.homeDir()).execution;
		const created = createTask(ctx.project, {
			description: request,
			mode: "auto",
			identity: deps.captureIdentity(workspaceId, ctx.worktreePath),
			limits: {
				budgetUsd: execution.taskBudgetUsd,
				maxCorrections: execution.maxCorrections,
				maxReviewRounds: execution.maxReviewRounds,
				maxEscalations: execution.maxEscalations,
			},
		});
		const now = new Date().toISOString();
		const task: TaskRecord = {
			...created,
			isRequest: true,
			chat: [
				{ role: "user", text: request, at: now },
				{
					role: "coordinator",
					text: "Plan agreed in the Team chat tab (Claude Code).",
					at: now,
					plan,
				},
			],
			teamAgents: deps.listAgents?.(workspaceId) ?? [],
			routeBy: "ai",
			routeReasons: ["planned in the Team chat tab"],
			specialistReason: "the Coordinator assigns a specialist to each subtask",
		};
		saveTask(ctx.project, task);
		await deps.controller().approvePlan(ctx.project, task.slug);
		const all = listTaskRecords(ctx.project);
		const started = getTask(ctx.project, task.slug) ?? task;
		return text(
			`Started. ${describePlan(started, all)}\n\nProgress also shows in ADE (Tasks, and Team plans).`,
		);
	};

	/** The plan with this id, or the latest started one. */
	const findPlan = (all: TaskRecord[], args: Record<string, unknown>) => {
		const id = typeof args.id === "string" ? args.id.trim() : "";
		const request = id
			? all.find((t) => t.slug === id && t.isRequest)
			: teamRequests(all).find((t) => (t.subtaskSlugs?.length ?? 0) > 0);
		return { id, request };
	};

	const status = (workspaceId: string, args: Record<string, unknown>) => {
		const ctx = deps.resolveWorkspace(workspaceId);
		const all = listTaskRecords(ctx.project);
		const { id, request } = findPlan(all, args);
		if (!request)
			return text(id ? `No plan ${id}.` : "No plan has started yet.", !!id);
		return text(describePlan(request, all));
	};

	const resumePlan = async (
		workspaceId: string,
		args: Record<string, unknown>,
	): Promise<ReturnType<typeof text>> => {
		const ctx = deps.resolveWorkspace(workspaceId);
		const all = listTaskRecords(ctx.project);
		const { id, request } = findPlan(all, args);
		if (!request)
			return text(id ? `No plan ${id}.` : "No plan has started yet.", true);
		const subtasks = (request.subtaskSlugs ?? [])
			.map((slug) => all.find((t) => t.slug === slug))
			.filter((t): t is TaskRecord => !!t);
		const stopped = subtasks.filter(
			(t) => STOPPED.includes(t.state) && !t.waitingForFolder,
		);
		if (
			request.state === "done" ||
			request.state === "cancelled" ||
			(!STOPPED.includes(request.state) && stopped.length === 0)
		) {
			return text(
				`Nothing to resume: the plan is ${request.state}.\n\n${describePlan(request, all)}`,
			);
		}

		const reasonOf = (t: TaskRecord) => (t.stateReason ?? t.state).trim();
		const userAsked = args.userAskedToResume === true;
		const resumes = request.coordinatorResumes ?? [];
		const onlyUser: string[] = [];
		const continuing: string[] = [];
		if (resumes.length >= MAX_COORDINATOR_RESUMES) {
			onlyUser.push(
				`It was already resumed from here ${resumes.length} times; further resumes are the user's (Resume in ADE's Tasks).`,
			);
		}
		if (!userAsked && USER_PAUSED.test((request.stateReason ?? "").trim())) {
			onlyUser.push(
				"The user paused this plan. Resume only if they ask; then call resume_plan with userAskedToResume: true.",
			);
		}
		for (const sub of stopped) {
			const name = `"${sub.title}"`;
			const reason = reasonOf(sub);
			const lastResume = [...resumes]
				.reverse()
				.find((r) => r.stopped.some((s) => s.slug === sub.slug));
			if (sub.permissionBlock) {
				onlyUser.push(
					`${name} tried a command that needs the user's approval: open it in ADE (Tasks), approve the command, then Resume.`,
				);
			} else if (sub.state === "needs-input") {
				onlyUser.push(
					`${name} has questions only the user can answer: open it in ADE (Tasks). ${reason}`,
				);
			} else if (taskSpend(sub).worstCaseUsd >= sub.limits.budgetUsd) {
				onlyUser.push(
					`${name} has used its $${sub.limits.budgetUsd.toFixed(2)} budget. Only the user can raise it (open the task in ADE's Tasks), then Resume.`,
				);
			} else if (!userAsked && USER_PAUSED.test(reason)) {
				onlyUser.push(
					`${name} was paused by the user. Resume only if they ask; then call resume_plan with userAskedToResume: true.`,
				);
			} else if (
				lastResume?.stopped.some(
					(s) => s.slug === sub.slug && s.reason === reason,
				)
			) {
				onlyUser.push(
					`${name} stopped the same way again after the last resume (${reason}). Resuming again would likely repeat it, so the user decides: Resume in ADE, accept the work as it is, or change the task.`,
				);
			} else if (ADE_CONTINUES.test(reason)) {
				continuing.push(`${name}: ${reason}`);
			}
		}
		if (onlyUser.length) {
			return text(
				[
					"Not resumed. Only the user can settle this:",
					...onlyUser.map((line) => `- ${line}`),
					"",
					describePlan(request, all),
				].join("\n"),
			);
		}
		if (stopped.length > 0 && continuing.length === stopped.length) {
			return text(
				[
					"Nothing to do: ADE continues these by itself.",
					...continuing.map((line) => `- ${line}`),
				].join("\n"),
			);
		}

		await withTaskLock(ctx.project, request.slug, () => {
			const fresh = getTask(ctx.project, request.slug);
			if (!fresh) return;
			fresh.coordinatorResumes = [
				...(fresh.coordinatorResumes ?? []),
				{
					at: new Date().toISOString(),
					stopped: stopped.map((s) => ({ slug: s.slug, reason: reasonOf(s) })),
				},
			];
			saveTask(ctx.project, fresh);
		});
		const after = await deps.controller().resume(ctx.project, request.slug);
		const why = stopped.map((s) => `"${s.title}" (${reasonOf(s)})`).join("; ");
		return text(
			`Resumed${why ? ` ${why}` : ""}.\n\n${describePlan(after, listTaskRecords(ctx.project))}`,
		);
	};

	const call = async (
		workspaceId: string,
		name: string,
		args: Record<string, unknown>,
	) => {
		switch (name) {
			case "team_overview":
				return text(overview(workspaceId));
			case "start_plan":
				return startPlan(workspaceId, args);
			case "plan_status":
				return status(workspaceId, args);
			case "resume_plan":
				return resumePlan(workspaceId, args);
			default:
				return text(`Unknown tool ${name}`, true);
		}
	};

	/** One JSON-RPC message; undefined for a notification (no reply). */
	const handleOne = async (workspaceId: string, message: JsonRpcRequest) => {
		const id = message.id ?? null;
		const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
		const fail = (code: number, msg: string) => ({
			jsonrpc: "2.0",
			id,
			error: { code, message: msg },
		});
		if (message.id === undefined) return undefined;
		try {
			switch (message.method) {
				case "initialize": {
					const asked = String(message.params?.protocolVersion ?? "");
					return reply({
						protocolVersion: SUPPORTED_VERSIONS.includes(asked)
							? asked
							: SUPPORTED_VERSIONS[0],
						capabilities: { tools: {} },
						serverInfo: { name: TEAM_MCP_NAME, version: "1.0.0" },
						instructions: INSTRUCTIONS,
					});
				}
				case "ping":
					return reply({});
				case "tools/list":
					return reply({ tools: TOOLS });
				case "tools/call": {
					const name = String(message.params?.name ?? "");
					const args = (message.params?.arguments ?? {}) as Record<
						string,
						unknown
					>;
					return reply(await call(workspaceId, name, args));
				}
				default:
					return fail(-32601, `Method not found: ${message.method}`);
			}
		} catch (error) {
			if (message.method === "tools/call") {
				return reply(
					text(error instanceof Error ? error.message : String(error), true),
				);
			}
			return fail(
				-32603,
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	/** A POST body: one message or a batch. Undefined means 202, no body. */
	return async (workspaceId: string, body: unknown) => {
		if (Array.isArray(body)) {
			const replies = (
				await Promise.all(
					body.map((m) => handleOne(workspaceId, m as JsonRpcRequest)),
				)
			).filter((r) => r !== undefined);
			return replies.length ? replies : undefined;
		}
		return handleOne(workspaceId, (body ?? {}) as JsonRpcRequest);
	};
}
