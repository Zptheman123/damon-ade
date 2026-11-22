/**
 * The rules for approving shell commands for agents, shared by ADE's main
 * process (which turns approvals into Claude Code --allowedTools rules) and
 * the Tasks panel (which checks a command as it is typed). See
 * main/lib/agent-workflow/command-approvals.ts.
 */

export type ShellTool = "Bash" | "PowerShell";
export const SHELL_TOOLS: ShellTool[] = ["Bash", "PowerShell"];

export interface CommandApproval {
	id: string;
	tool: ShellTool;
	/** The command, or (prefix) the start every allowed command shares. */
	command: string;
	/** "exact": only this command; "prefix": this command plus arguments. */
	match: "exact" | "prefix";
	/** Where the command was asked for (shown to the user; the CLI's rules do not scope by folder). */
	cwd?: string;
	/** The task whose blocked run asked for it. */
	fromTask?: string;
	approvedAt: string;
}

/** One entry of the CLI's `result.permission_denials`. */
export interface PermissionDenial {
	toolName: string;
	toolUseId?: string;
	input: Record<string, unknown>;
}

const MAX_LENGTH = 300;

/** Shell syntax that joins or nests commands; each part is approved alone. */
const COMPOUND = /&&|\|\||[;|`\n\r]|\$\(|<\(|>\(/;
/** Redirection and backgrounding change what an approved command does. */
const REDIRECT = /(^|\s)\d?[<>]|&\s*$/;

/** Programs that run whatever they are given: never approved by prefix. */
const RUNNERS = new Set([
	"node",
	"nodejs",
	"deno",
	"bun",
	"bunx",
	"npx",
	"pnpx",
	"python",
	"python3",
	"py",
	"ruby",
	"perl",
	"php",
	"bash",
	"sh",
	"zsh",
	"pwsh",
	"powershell",
	"cmd",
	"cmd.exe",
	"sudo",
	"env",
	"xargs",
	"eval",
	"exec",
	"curl",
	"wget",
	"iex",
	"invoke-expression",
]);

/** Package managers: a prefix must name the subcommand and its target. */
const PACKAGE_MANAGERS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"cargo",
	"pip",
	"pip3",
	"uv",
	"go",
	"dotnet",
	"gradle",
	"mvn",
]);
/** Subcommands that run arbitrary scripts or packages. */
const DISPATCH = new Set([
	"run",
	"run-script",
	"exec",
	"x",
	"dlx",
	"start",
	"test",
]);

function tokens(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

/** Why an approval would be unsafe or would never match, or undefined. */
export function approvalProblem(input: {
	tool: string;
	command: string;
	match: "exact" | "prefix";
}): string | undefined {
	const command = input.command.trim();
	if (!SHELL_TOOLS.includes(input.tool as ShellTool)) {
		return "Only Bash and PowerShell commands can be approved.";
	}
	if (!command) return "Enter the command.";
	if (command.length > MAX_LENGTH) return "That command is too long.";
	if (command.includes("*")) {
		return "Wildcards are not allowed: approve the exact command.";
	}
	if (/^[\w./-]*:\s*$/.test(command) || command.endsWith(":")) {
		return "That command is incomplete.";
	}
	if (COMPOUND.test(command)) {
		return "This joins several commands (&&, ;, |, …). The CLI checks each part on its own, so approve each part separately.";
	}
	if (REDIRECT.test(command)) {
		return "Commands with redirection (> <) or & can't be approved; approve the command itself.";
	}
	if (input.match === "prefix") {
		if (input.tool === "PowerShell") {
			return "PowerShell commands can only be approved exactly.";
		}
		const parts = tokens(command);
		const program = parts[0].toLowerCase().replace(/\.(exe|cmd)$/, "");
		if (RUNNERS.has(program)) {
			return `"${parts[0]}" runs whatever it is given, so it can only be approved for one exact command.`;
		}
		if (parts.length < 2) {
			return `That would allow every "${parts[0]}" command. Approve the exact command, or include its subcommand.`;
		}
		if (PACKAGE_MANAGERS.has(program)) {
			const sub = parts[1].toLowerCase();
			if (DISPATCH.has(sub)) {
				return `"${parts[0]} ${parts[1]}" runs project scripts or packages; with any arguments it could run more than you mean. Approve the exact command.`;
			}
			if (parts.length < 3) {
				return `That would allow "${parts[0]} ${parts[1]}" with any package or option. Approve the exact command, or name what it acts on (e.g. "${parts[0]} ${parts[1]} <package>").`;
			}
		}
	}
	return undefined;
}

/** The CLI rule for an approval. */
export function approvalRule(
	approval: Pick<CommandApproval, "tool" | "command" | "match">,
): string {
	const command = approval.command.trim().replace(/\s+/g, " ");
	return approval.match === "prefix"
		? `${approval.tool}(${command}:*)`
		: `${approval.tool}(${command})`;
}

export interface DeniedOperation {
	tool: string;
	/** For Bash and PowerShell: the command as the agent ran it. */
	command?: string;
	/** For file tools: the path. */
	path?: string;
	/** One line for people. */
	text: string;
	/** Whether it can be approved here as it is (one plain shell command). */
	approvable: boolean;
	/** Why not, when it can't. */
	problem?: string;
}

/** Whether an approval lets the CLI run this denied operation now. */
export function approvalCovers(
	approval: Pick<CommandApproval, "tool" | "command" | "match">,
	op: Pick<DeniedOperation, "tool" | "command">,
): boolean {
	if (approval.tool !== op.tool || !op.command) return false;
	const command = op.command.trim().replace(/[ \t]+/g, " ");
	const rule = approval.command.trim().replace(/[ \t]+/g, " ");
	return approval.match === "exact"
		? command === rule
		: command === rule || command.startsWith(`${rule} `);
}
