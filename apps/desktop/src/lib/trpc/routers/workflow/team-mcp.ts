import { execFileSync } from "node:child_process";
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
import { planEta } from "main/lib/agent-workflow/plan-eta";
import { listSkills } from "main/lib/agent-workflow/skills";
import {
	MAX_TEAM_CHAT_SUBTASKS,
	parseSplit,
	type SplitPlan,
} from "main/lib/agent-workflow/split";
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

const INSTRUCTIONS = `You are the Coordinator of this ADE team. The user tells you here what they want; the team's agents build it after the user says go. Your job: understand exactly what the user envisions, plan it, then make sure the agents deliver that vision, reviewing every piece and asking for specific revisions until it matches, without the user having to come back.

Discern the vision first:
- At the start of a conversation call team_overview once, to learn the team's specialists and which agent does each.
- Talk in short, plain sentences. Read the code yourself to answer what you can; never edit files or build the work yourself.
- Find out what the user pictures: who it is for, the features and flows that must work, the look and feel (style, references, colours, layout, tone), the platforms, what "done" looks like, and what to leave out. Ask only what only they know: at most three focused questions per message, offering concrete options where that helps. Notice what they imply, not just what they say.
- Then write a vision brief: concrete and testable (goals; each feature with how to tell it works; look and feel; constraints; out of scope). Show it and ask them to confirm or correct it. Every agent receives this brief, and you judge their work against it, so make it precise.
- Ask how long they want it to run unattended (for example 4 hours) if they have not said.

Plan:
${PLANNING_PRINCIPLES}
- Use the whole team: each specialist has its own agent, folder and branch, so subtasks on different agents run at the same time. Give each subtask to the specialist whose specialty fits it best (the data model and migrations: Database; endpoints and contracts: API; server logic: Backend; screens and flows: Frontend, Mobile, Desktop or Game development; the visual design system of a new product: UI; flows and onboarding: UX; deployment and CI: DevOps), and split a large build into independent features on different agents so they run in parallel. Subtasks that change the same files must not run at the same time: make one wait for the other.
- In a long unattended run, after the features exist, add specialist passes over the whole product where the team has them: QA (an end-to-end test of the vision's flows, fixing what fails), Security (review of authentication, permissions, secrets and input handling), Performance (load time and slow paths) and Documentation (README and how to run it). These are the exception to "never make separate QA or testing passes" above, and only for long runs.
- Skills: team_overview lists the Claude Code skills installed (the user's, this repository's and their plugins'). When a subtask's work matches a skill's description, or what the user implied calls for it (a polished interface: a design skill; deploying: a deploy skill; React performance: a React skill), give that subtask those skills by name. Its agent loads them before it starts. Pick only what fits that subtask, name the skills in the plan you show the user, and never invent a skill that is not listed.
- A long unattended run may use more subtasks (up to ${MAX_TEAM_CHAT_SUBTASKS}): whole features, in the order they build on each other, with a last subtask that checks the whole app end to end against the vision and fixes what falls short.
- Propose a plan as a numbered list. For each subtask: a short title, what to build and how to know it is done (its acceptance criteria from the vision brief), the specialist (by name, or "none"), the route ("quick", "implement", "plan" or "exceptional"), the model per role, the skills it uses (if any), an honest estimate in minutes (including checks and review: about 10 for quick work, 20 to 40 for a normal feature, 45 to 90 for a large one), and which earlier subtasks it waits for. Independent subtasks run at the same time on their agents. Revise the plan whenever the user asks.
- Models, as cheaply as is reliable: haiku only for trivial low-risk work, sonnet for normal work, opus for planning or reviewing difficult or risky work, fable only for exceptional architecture. Risky work (authentication, permissions, secrets, payments, data migrations, messaging people) is never "quick".
- Only when the user clearly says to start (for example "go"), call start_plan with their request, the confirmed vision brief, the hours they agreed to and the exact plan. Then tell them they can leave: you review each finished subtask, ask for revisions, and report when it is done; the countdown in ADE's top bar shows the time left.

While it runs (the user is away: never wait for them):
- ADE types messages starting with "[ADE]" into this chat when a subtask finishes or stops, and when the plan ends. They come from ADE, not the user. Act on each at once.
- A finished subtask: call review_subtask and read the agent's report, the reviewer's verdict, the checks and the changes (read the changed files when the diff is not enough). Compare it with the vision brief and the subtask's acceptance criteria. If it matches, approve_subtask. If not, revise_subtask with specific, actionable instructions: what is wrong, where, and exactly what it must be instead (file, behaviour, wording, layout, colours). Never vague ("make it better"). Up to 3 revisions per subtask; after that approve it and add_subtask for what is left. A review you do not answer within 20 minutes is approved by itself, so answer promptly.
- A stopped subtask: call resume_plan when ADE can get past the stop; when unclear instructions caused it, revise_subtask with clearer ones. Tell the user only what only they can settle.
- Work the plan missed: add_subtask.
- When the plan is finished: check the whole result against the vision brief, revise or add what still falls short, then give the user a short report: what was built, how to try it, and anything left.`;

const SUBTASK_PROPERTIES = {
	title: { type: "string" },
	description: {
		type: "string",
		description:
			"What to build, the interfaces it uses or provides, and its acceptance criteria (how to know it is done, from the vision brief).",
	},
	specialist: {
		type: "string",
		description: 'A specialist\'s name from team_overview, or "none".',
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
	minutes: {
		type: "integer",
		description:
			"Estimated minutes, including checks and review (for the countdown).",
	},
	skills: {
		type: "array",
		items: { type: "string" },
		description:
			'Installed skills (names from team_overview, e.g. "frontend-design" or "vercel:deploy") the agent loads for this work; [] if none fits.',
	},
} as const;

const SUBTASK_REF = {
	type: "string",
	description:
		"The subtask: its id (from plan_status), or its number in the latest plan.",
} as const;

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
			"Start the agreed plan: ADE creates one task per subtask, on the specialist's agent, and runs them (independent ones at the same time) with checks and review. Every agent gets the vision brief. Each finished subtask waits for your review (review_subtask, then approve_subtask or revise_subtask). This spends money on model runs. Call it only after the user has clearly said to start.",
		inputSchema: {
			type: "object",
			required: ["request", "plan"],
			properties: {
				request: {
					type: "string",
					description: "What the user asked for, in one or two sentences.",
				},
				vision: {
					type: "string",
					description:
						"The vision brief the user confirmed: goals, features with acceptance criteria, look and feel, constraints, out of scope.",
				},
				hours: {
					type: "number",
					description:
						"The time box the user agreed to (0.5 to 8): no new work starts after it.",
				},
				review: {
					type: "boolean",
					description:
						"Review each finished subtask before the work built on it starts (default true).",
				},
				budgetUsdPerSubtask: {
					type: "number",
					description:
						"Only if the user agreed to it in this conversation: the most each subtask may spend, in US dollars (up to 50). Without it, ADE's setting applies.",
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
							maxItems: MAX_TEAM_CHAT_SUBTASKS,
							items: {
								type: "object",
								required: ["title", "description", "route"],
								properties: {
									...SUBTASK_PROPERTIES,
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
			"How a started plan is going: each subtask's id, agent, state, review and reason, and the time left. Without an id, the latest plan. Read-only.",
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
	{
		name: "review_subtask",
		description:
			"What an agent did for a subtask: its final report, the reviewer's verdict, the checks, the files it changed and the diff. Read-only.",
		inputSchema: {
			type: "object",
			required: ["subtask"],
			properties: { subtask: SUBTASK_REF },
		},
	},
	{
		name: "approve_subtask",
		description:
			"The finished subtask matches the vision: the work built on it may start (and the plan may finish).",
		inputSchema: {
			type: "object",
			required: ["subtask"],
			properties: {
				subtask: SUBTASK_REF,
				note: {
					type: "string",
					description: "Optional: what you checked, for the record.",
				},
			},
		},
	},
	{
		name: "revise_subtask",
		description:
			"Send a subtask back to its agent with specific changes to make. The agent runs again with your instructions, then the checks and the review, and the subtask comes back to you. Up to 3 revisions per subtask. Uses model runs.",
		inputSchema: {
			type: "object",
			required: ["subtask", "instructions"],
			properties: {
				subtask: SUBTASK_REF,
				instructions: {
					type: "string",
					description:
						"Exactly what is wrong, where, and what it must be instead (files, behaviour, wording, layout, colours).",
				},
			},
		},
	},
	{
		name: "add_subtask",
		description:
			"Add a subtask to a started plan (work it missed, or what is left after revisions). It runs on its specialist's agent once the subtasks it waits for are approved. Uses model runs.",
		inputSchema: {
			type: "object",
			required: ["title", "description", "route"],
			properties: {
				id: { type: "string", description: "The plan id; default the latest." },
				...SUBTASK_PROPERTIES,
				dependsOn: {
					type: "array",
					items: { type: "string" },
					description:
						"Ids (or numbers) of subtasks in the plan whose work this one needs; [] if none.",
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
				// Reviewing and revising the agents' work while the user is
				// away (bounded: 3 revisions per subtask, a plan of at most 12
				// subtasks, nothing after the agreed time box).
				`mcp__${TEAM_MCP_NAME}__review_subtask`,
				`mcp__${TEAM_MCP_NAME}__approve_subtask`,
				`mcp__${TEAM_MCP_NAME}__revise_subtask`,
				`mcp__${TEAM_MCP_NAME}__add_subtask`,
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
	const reviewOf = (sub: TaskRecord) => {
		if (!request.coordinator?.review || sub.state !== "done") return "";
		const review = sub.review;
		if (!review) return ", review pending";
		if (review.state === "approved") {
			return review.by === "coordinator"
				? ", approved by you"
				: ", approved by ADE (no review in time)";
		}
		return review.state === "waiting" ? ", WAITING FOR YOUR REVIEW" : "";
	};
	const lines = subtasks.map((sub, i) =>
		sub
			? `${i + 1}. ${sub.title} [id ${sub.slug}] — ${sub.agentName ? `${sub.agentName}, ` : ""}${sub.state}${reviewOf(sub)}${sub.skills?.length ? `, skills: ${sub.skills.join(", ")}` : ""}${sub.revisions?.length ? `, revised ${sub.revisions.length}x` : ""}${sub.stateReason && sub.state !== "done" ? ` (${sub.stateReason})` : ""}`
			: `${i + 1}. (missing)`,
	);
	const children = subtasks.filter((t): t is TaskRecord => !!t);
	const eta = request.coordinator
		? planEta(request, children, new Date())
		: undefined;
	return [
		`Plan ${request.slug}: "${request.title}" — ${request.state}${request.stateReason ? `: ${request.stateReason}` : ""}`,
		...lines,
		...(eta && request.state !== "done" && request.state !== "cancelled"
			? [
					`Time left: about ${Math.round(eta.remainingMinutes)} minutes${eta.deadline ? ` (time box ends ${eta.deadline})` : ""}.`,
				]
			: []),
	].join("\n");
}

/** The subtask an argument names: its id, or its number in the plan. */
function findSubtask(
	all: TaskRecord[],
	plan: TaskRecord | undefined,
	ref: unknown,
): TaskRecord | undefined {
	const value = String(ref ?? "").trim();
	if (!value) return undefined;
	if (/^\d+$/.test(value)) {
		const slug = plan?.subtaskSlugs?.[Number(value) - 1];
		return slug ? all.find((t) => t.slug === slug) : undefined;
	}
	return all.find((t) => t.slug === value && !!t.parentSlug);
}

function git(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
			timeout: 15_000,
			windowsHide: true,
		});
	} catch {
		return "";
	}
}

const clip = (value: string, max: number) =>
	value.length > max
		? `${value.slice(0, max)}\n… (${value.length - max} more characters; read the files for the rest)`
		: value;

/** What an agent did for a subtask, for the Team chat's review. */
function describeWork(sub: TaskRecord): string {
	const runs = sub.runs.filter((r) => r.status === "succeeded");
	const lastOf = (test: (r: (typeof runs)[number]) => boolean) =>
		[...runs].reverse().find(test);
	const report = lastOf((r) =>
		["quick", "implement", "build", "fix"].includes(r.kind),
	);
	const review = lastOf((r) => r.kind === "review");
	const checks = [...sub.runs]
		.reverse()
		.find((r) => r.kind === "checks" && !r.baseline);
	const cwd = sub.identity.worktreePath;
	const base = sub.identity.baselineHead;
	const stat = base ? git(cwd, ["diff", "--stat", base]).trim() : "";
	const diff = base ? git(cwd, ["diff", base]) : "";
	const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"])
		.split(/\r?\n/)
		.filter(Boolean)
		.slice(0, 30);
	return [
		`Subtask "${sub.title}" [id ${sub.slug}] — ${sub.state}${sub.stateReason ? `: ${sub.stateReason}` : ""}`,
		`Agent: ${sub.agentName ?? "the team's folder"}; folder ${cwd}${sub.identity.branch ? ` (branch ${sub.identity.branch})` : ""}.`,
		sub.revisions?.length
			? `Revisions asked so far: ${sub.revisions.length}. Latest: ${clip(sub.revisions.at(-1)?.text ?? "", 600)}`
			: "",
		"",
		"## The agent's final report",
		clip(report?.summary?.trim() || "(no report)", 4000),
		"",
		"## The independent reviewer",
		review
			? `VERDICT ${review.verdict ?? "none"}. ${clip(review.summary?.trim() ?? "", 3000)}`
			: "(no review run)",
		"",
		"## Checks",
		checks?.checks?.length
			? checks.checks
					.map(
						(c) =>
							`- ${c.command}: ${c.timedOut ? "timed out" : c.exitCode === 0 ? "passed" : `failed (exit ${c.exitCode})`}`,
					)
					.join("\n")
			: "(none configured)",
		"",
		"## Changes",
		stat || "(no committed or tracked changes since the subtask started)",
		untracked.length ? `New files not yet in git: ${untracked.join(", ")}` : "",
		diff ? `\n\`\`\`diff\n${clip(diff, 14_000)}\n\`\`\`` : "",
	]
		.filter((line) => line !== "")
		.join("\n");
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
		const skills = listSkills({ projectRoot: ctx.project.root })
			.slice(0, 120)
			.map(
				(s) =>
					`- ${s.name}${s.source === "project" ? " (this repository's)" : ""}: ${s.description.slice(0, 220) || "(no description)"}`,
			);
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
			"Skills the agents can use (give a subtask the ones its work calls for):",
			...(skills.length ? skills : ["- none installed"]),
			"",
			"Latest plans:",
			...(plans.length ? plans : ["- none yet"]),
		].join("\n");
	};

	/** A plan's skills that are installed, and the names that are not. */
	const checkSkills = (root: string, plan: SplitPlan) => {
		const installed = new Set(
			listSkills({ projectRoot: root }).map((s) => s.name),
		);
		const missing = new Set<string>();
		for (const sub of plan.subtasks) {
			if (!sub.skills) continue;
			for (const name of sub.skills) {
				if (!installed.has(name)) missing.add(name);
			}
			sub.skills = sub.skills.filter((name) => installed.has(name));
			if (!sub.skills.length) sub.skills = undefined;
		}
		return missing.size
			? `\n\nNot installed, so left out: ${[...missing].join(", ")}. team_overview lists the skills there are.`
			: "";
	};

	const startPlan = async (
		workspaceId: string,
		args: Record<string, unknown>,
	): Promise<ReturnType<typeof text>> => {
		const request = typeof args.request === "string" ? args.request.trim() : "";
		if (!request) return text("start_plan needs the user's request.", true);
		const plan = parseSplit(
			`\`\`\`json\n${JSON.stringify(args.plan ?? {})}\n\`\`\``,
			MAX_TEAM_CHAT_SUBTASKS,
		);
		if (!plan) {
			return text(
				"The plan could not be read: it needs subtasks, each with a title and a description.",
				true,
			);
		}
		const vision =
			typeof args.vision === "string" ? args.vision.trim().slice(0, 8000) : "";
		const hours = Number(args.hours);
		const budget = Number(args.budgetUsdPerSubtask);
		const ctx = deps.resolveWorkspace(workspaceId);
		const skillNote = checkSkills(ctx.project.root, plan);
		const execution = loadWorkflowSettings(deps.homeDir()).execution;
		const startedAt = new Date();
		const created = createTask(ctx.project, {
			description: vision
				? `${request}\n\n## The user's vision (confirmed in the Team chat)\n${vision}`
				: request,
			mode: "auto",
			identity: deps.captureIdentity(workspaceId, ctx.worktreePath),
			limits: {
				budgetUsd:
					Number.isFinite(budget) && budget > 0
						? Math.min(budget, 50)
						: execution.taskBudgetUsd,
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
			coordinator: {
				vision: vision || undefined,
				review: args.review !== false,
				startedAt: startedAt.toISOString(),
				deadline:
					Number.isFinite(hours) && hours > 0
						? new Date(
								startedAt.getTime() + Math.min(hours, 8) * 3_600_000,
							).toISOString()
						: undefined,
			},
		};
		saveTask(ctx.project, task);
		await deps.controller().approvePlan(ctx.project, task.slug);
		const all = listTaskRecords(ctx.project);
		const started = getTask(ctx.project, task.slug) ?? task;
		const reviewing = task.coordinator?.review
			? " Each subtask waits for your review when it finishes: ADE types an [ADE] message here; then review_subtask, and approve_subtask or revise_subtask."
			: "";
		return text(
			`Started. ${describePlan(started, all)}\n\nProgress also shows in ADE (Tasks, Team plans, and the countdown in the top bar).${reviewing}${skillNote}`,
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

	/** The subtask a tool call names, in the plan it belongs to. */
	const subtaskFor = (workspaceId: string, args: Record<string, unknown>) => {
		const ctx = deps.resolveWorkspace(workspaceId);
		const all = listTaskRecords(ctx.project);
		const { request } = findPlan(all, {});
		const sub = findSubtask(all, request, args.subtask);
		if (!sub) {
			throw new Error(
				`No subtask "${String(args.subtask ?? "")}". Use the id or number from plan_status.`,
			);
		}
		return { ctx, all, sub };
	};

	const reviewSubtask = (
		workspaceId: string,
		args: Record<string, unknown>,
	) => {
		const { sub } = subtaskFor(workspaceId, args);
		return text(describeWork(sub));
	};

	const approveSubtask = async (
		workspaceId: string,
		args: Record<string, unknown>,
	) => {
		const { ctx, sub } = subtaskFor(workspaceId, args);
		await deps
			.controller()
			.coordinatorApprove(
				ctx.project,
				sub.slug,
				typeof args.note === "string" ? args.note : undefined,
			);
		return text(
			`Approved "${sub.title}". The work built on it starts now (plan_status shows it).`,
		);
	};

	const reviseSubtask = async (
		workspaceId: string,
		args: Record<string, unknown>,
	) => {
		const { ctx, sub } = subtaskFor(workspaceId, args);
		const instructions =
			typeof args.instructions === "string" ? args.instructions : "";
		const after = await deps
			.controller()
			.coordinatorRevise(ctx.project, sub.slug, instructions);
		return text(
			`Sent back to ${sub.agentName ?? "its agent"}: "${sub.title}" (revision ${after.revisions?.length ?? 1}). It runs again with your instructions, then the checks and the review; ADE tells you here when it is ready for your review again.`,
		);
	};

	const addSubtask = async (
		workspaceId: string,
		args: Record<string, unknown>,
	) => {
		const ctx = deps.resolveWorkspace(workspaceId);
		const all = listTaskRecords(ctx.project);
		const { id, request } = findPlan(all, args);
		if (!request) {
			return text(id ? `No plan ${id}.` : "No plan has started yet.", true);
		}
		const parsed = parseSplit(
			`\`\`\`json\n${JSON.stringify({ reason: "added", subtasks: [{ ...args, dependsOn: [] }] })}\n\`\`\``,
		);
		const subtask = parsed?.subtasks[0];
		if (!parsed || !subtask) {
			return text("add_subtask needs a title and a description.", true);
		}
		const skillNote = checkSkills(ctx.project.root, parsed);
		const dependsOn: string[] = [];
		for (const ref of Array.isArray(args.dependsOn) ? args.dependsOn : []) {
			const dep = findSubtask(all, request, ref);
			if (!dep || dep.parentSlug !== request.slug) {
				return text(`"${String(ref)}" is not a subtask of this plan.`, true);
			}
			dependsOn.push(dep.slug);
		}
		const after = await deps
			.controller()
			.coordinatorAddSubtask(ctx.project, request.slug, subtask, dependsOn);
		return text(
			`Added "${subtask.title}".${skillNote}\n\n${describePlan(after, listTaskRecords(ctx.project))}`,
		);
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
			case "review_subtask":
				return reviewSubtask(workspaceId, args);
			case "approve_subtask":
				return approveSubtask(workspaceId, args);
			case "revise_subtask":
				return reviseSubtask(workspaceId, args);
			case "add_subtask":
				return addSubtask(workspaceId, args);
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
