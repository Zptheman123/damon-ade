import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	approvalProblem,
	type CommandApproval,
	type DeniedOperation,
	type PermissionDenial,
	SHELL_TOOLS,
	type ShellTool,
} from "shared/utils/command-approval-rules";
import type { ProjectWorkflow } from "./project-workflow";

export {
	approvalCovers,
	approvalProblem,
	approvalRule,
	type CommandApproval,
	type DeniedOperation,
	type PermissionDenial,
	SHELL_TOOLS,
	type ShellTool,
} from "shared/utils/command-approval-rules";

const FILE = "command-approvals.json";
const MAX_APPROVALS = 50;

/**
 * Command approvals: the exact shell commands the user lets this project's
 * implementing runs execute (installing dependencies, running a generator),
 * separate from the checks ADE runs to verify work (checks.ts).
 *
 * They become Claude Code `--allowedTools` rules, whose matching was read
 * from the installed CLI (2.1.330):
 * - `Bash(cmd)` is exact: each part of a compound command must equal `cmd`.
 * - `Bash(cmd:*)` is a prefix: the part equals `cmd` or starts with `cmd `.
 * - Any other `*` makes a wildcard. ADE never writes one.
 * PowerShell rules use the same `PowerShell(...)` form; ADE approves only
 * exact PowerShell commands, because its prefix matching was not verified.
 * Never a whole program (`npm *`, `node *`), never every `npm run` script,
 * never bypassPermissions.
 */

export function loadCommandApprovals(
	project: Pick<ProjectWorkflow, "dir">,
): CommandApproval[] {
	try {
		const parsed = JSON.parse(
			readFileSync(join(project.dir, FILE), "utf8"),
		) as {
			approvals?: CommandApproval[];
		};
		return (parsed.approvals ?? []).filter(
			(a) =>
				a &&
				typeof a.command === "string" &&
				SHELL_TOOLS.includes(a.tool) &&
				(a.match === "exact" || a.match === "prefix") &&
				// A file edited by hand never widens what runs.
				!approvalProblem(a),
		);
	} catch {
		return [];
	}
}

function readFile(project: Pick<ProjectWorkflow, "dir">): {
	approvals?: CommandApproval[];
	projectCommands?: boolean;
} {
	try {
		return JSON.parse(readFileSync(join(project.dir, FILE), "utf8"));
	} catch {
		return {};
	}
}

function save(
	project: Pick<ProjectWorkflow, "dir">,
	approvals: CommandApproval[],
	projectCommands: boolean = projectCommandsEnabled(project),
) {
	const path = join(project.dir, FILE);
	writeFileSync(
		`${path}.tmp`,
		`${JSON.stringify({ version: 1, projectCommands, approvals }, null, 2)}\n`,
		"utf8",
	);
	renameSync(`${path}.tmp`, path);
}

/**
 * "Project commands": agents may install dependencies and run the
 * project's own package.json scripts without asking. On unless the user
 * turned it off for the project.
 */
export function projectCommandsEnabled(
	project: Pick<ProjectWorkflow, "dir">,
): boolean {
	return readFile(project).projectCommands !== false;
}

export function setProjectCommands(
	project: Pick<ProjectWorkflow, "dir">,
	enabled: boolean,
): void {
	save(project, loadCommandApprovals(project), enabled);
}

/** Script names that are safe to put in a rule as they are. */
const SCRIPT_NAME = /^[\w:.@/-]{1,80}$/;

/**
 * The project's own commands, as exact rules: installing dependencies,
 * each package.json script by name, and read-only registry lookups. Read
 * from the folder at the time of the run, so a script added since is
 * included and a removed one is not. Never npx, node -e, or arbitrary
 * package installs (add a dependency to package.json, then install).
 */
export function projectCommands(cwd: string): string[] {
	let scripts: string[] = [];
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
			scripts?: Record<string, unknown>;
		};
		scripts = Object.keys(pkg.scripts ?? {}).filter((name) =>
			SCRIPT_NAME.test(name),
		);
	} catch {
		// No package.json yet: installing is still allowed (scaffolding).
	}
	const has = (file: string) => existsSync(join(cwd, file));
	const manager = has("pnpm-lock.yaml")
		? "pnpm"
		: has("yarn.lock")
			? "yarn"
			: has("bun.lock") || has("bun.lockb")
				? "bun"
				: "npm";
	const install =
		manager === "npm"
			? ["npm install", "npm ci"]
			: manager === "yarn"
				? ["yarn install", "yarn"]
				: [`${manager} install`];
	const run = scripts.map((name) => `${manager} run ${name}`);
	const test =
		scripts.includes("test") && manager !== "bun" ? [`${manager} test`] : [];
	return [...install, ...test, ...run];
}

/** CLI rules for the project's commands, for Bash and PowerShell alike. */
export function projectCommandRules(cwd: string): string[] {
	const commands = projectCommands(cwd);
	const lookups = ["npm view:*", "npm ls:*", "npm outdated:*"];
	return [
		...commands.flatMap((c) => [`Bash(${c})`, `PowerShell(${c})`]),
		...lookups.map((c) => `Bash(${c})`),
	];
}

/** What an implementing run is told it may run without asking. */
export function projectCommandsNote(cwd: string): string {
	const commands = projectCommands(cwd);
	return `## Commands you can run without asking
${commands.map((c) => `- \`${c}\``).join("\n")}
- \`npm view …\`, \`npm ls …\` and \`npm outdated …\` (read-only lookups)
To add a dependency, add it to package.json and run the install command above; do not install packages by name. A script you add to package.json can be run as \`… run <name>\` from the next run on. Run each command on its own (no \`&&\`, \`;\` or pipes) from the repository root. Anything else needs the user's approval: avoid it where you can.`;
}

export function addCommandApproval(
	project: Pick<ProjectWorkflow, "dir">,
	input: {
		tool: ShellTool;
		command: string;
		match: "exact" | "prefix";
		cwd?: string;
		fromTask?: string;
	},
	now: Date = new Date(),
): CommandApproval {
	const problem = approvalProblem(input);
	if (problem) throw new Error(problem);
	const command = input.command.trim().replace(/\s+/g, " ");
	const approvals = loadCommandApprovals(project);
	const existing = approvals.find(
		(a) =>
			a.tool === input.tool && a.command === command && a.match === input.match,
	);
	if (existing) return existing;
	if (approvals.length >= MAX_APPROVALS) {
		throw new Error(`At most ${MAX_APPROVALS} approved commands per project.`);
	}
	const approval: CommandApproval = {
		id: randomUUID(),
		tool: input.tool,
		command,
		match: input.match,
		cwd: input.cwd,
		fromTask: input.fromTask,
		approvedAt: now.toISOString(),
	};
	save(project, [...approvals, approval]);
	return approval;
}

export function removeCommandApproval(
	project: Pick<ProjectWorkflow, "dir">,
	id: string,
): void {
	save(
		project,
		loadCommandApprovals(project).filter((a) => a.id !== id),
	);
}

/** The CLI's `permission_denials`, in its documented shape. */
export function parseDenials(raw: unknown): PermissionDenial[] {
	if (!Array.isArray(raw)) return [];
	const out: PermissionDenial[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.tool_name !== "string") continue;
		out.push({
			toolName: e.tool_name,
			toolUseId: typeof e.tool_use_id === "string" ? e.tool_use_id : undefined,
			input:
				e.tool_input && typeof e.tool_input === "object"
					? (e.tool_input as Record<string, unknown>)
					: {},
		});
	}
	return out;
}

/** What was denied, for people, without repeats. */
export function describeDenials(
	denials: PermissionDenial[],
): DeniedOperation[] {
	const seen = new Set<string>();
	const out: DeniedOperation[] = [];
	for (const d of denials) {
		const command =
			typeof d.input.command === "string" ? d.input.command.trim() : undefined;
		const path =
			typeof d.input.file_path === "string"
				? d.input.file_path
				: typeof d.input.path === "string"
					? d.input.path
					: undefined;
		const key = `${d.toolName}\u0000${command ?? path ?? JSON.stringify(d.input)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const shell = SHELL_TOOLS.includes(d.toolName as ShellTool);
		const problem =
			shell && command
				? approvalProblem({ tool: d.toolName, command, match: "exact" })
				: shell
					? "No command was recorded."
					: `${d.toolName} is not a shell command; ADE approves only Bash and PowerShell commands.`;
		out.push({
			tool: d.toolName,
			command,
			path,
			text: command
				? `${d.toolName}: ${command}`
				: path
					? `${d.toolName}: ${path}`
					: d.toolName,
			approvable: !problem,
			problem,
		});
	}
	return out;
}

/** Progress statuses that state the work is finished, or needed nothing. */
const FINISHED =
	/^(implemented|done|complete[d]?|finished|already (done|implemented|present)|no changes? (needed|required))\b/i;

/**
 * What a run's denials mean for the task, from explicit evidence: the
 * status the run itself wrote to progress.md. A run that wrote a finished
 * status had an optional command refused; one that wrote nothing new, or
 * wrote "blocked" or "in progress", still has required work blocked. An
 * unchanged repository alone is never read as failure.
 */
export function permissionOutcome(input: {
	denials: PermissionDenial[];
	/** progress.md's Status, when this run wrote it. */
	freshStatus?: string;
}): "none" | "optional" | "blocked" {
	if (input.denials.length === 0) return "none";
	if (input.freshStatus && FINISHED.test(input.freshStatus.trim())) {
		return "optional";
	}
	return "blocked";
}

/** Earlier ADE versions recorded these as finished; their own words say otherwise. */
export function legacyPermissionBlocked(
	summary: string | undefined,
	progress: string,
): boolean {
	const blockedNow = /^Status:\s*blocked\b/im.test(progress);
	const aboutPermission =
		/requires approval|permission (layer|mode|settings|denied)|denied by (the )?permission|not (been )?granted|command permission/i;
	return (
		blockedNow &&
		aboutPermission.test(progress) &&
		aboutPermission.test(summary ?? "")
	);
}
