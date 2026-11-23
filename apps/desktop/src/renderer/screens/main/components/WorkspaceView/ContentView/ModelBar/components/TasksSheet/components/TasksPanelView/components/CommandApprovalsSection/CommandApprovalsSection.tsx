import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Switch } from "@superset/ui/switch";
import { useState } from "react";
import { LuTerminal, LuX } from "react-icons/lu";
import {
	approvalProblem,
	approvalRule,
	type ShellTool,
} from "shared/utils/command-approval-rules";
import type { ApprovalsView, TaskActions } from "../../../../types";

interface CommandApprovalsSectionProps {
	approvals: ApprovalsView | undefined;
	actions: TaskActions;
}

/**
 * Commands this project's implementing runs may execute (installing
 * dependencies, scaffolding before package.json exists). Separate from
 * Checks, which ADE runs itself to verify work. Each is one exact command,
 * or one command with extra arguments where that is safe; never a whole
 * program.
 */
export function CommandApprovalsSection({
	approvals,
	actions,
}: CommandApprovalsSectionProps) {
	const [tool, setTool] = useState<ShellTool>("Bash");
	const [command, setCommand] = useState("");
	const [match, setMatch] = useState<"exact" | "prefix">("exact");
	const list = approvals?.approvals ?? [];
	const typed = command.trim();
	const problem = typed
		? approvalProblem({ tool, command: typed, match })
		: undefined;

	return (
		<section
			className="space-y-2.5 rounded-lg border bg-card p-3 shadow-xs"
			data-section="command-approvals"
		>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<LuTerminal className="size-4 text-muted-foreground" aria-hidden />
					<h3 className="text-sm font-semibold">Command approvals</h3>
				</div>
				<span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
					{list.length} approved
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				Commands agents may run while implementing (for example{" "}
				<code className="font-mono">npm install</code> before the project
				exists). Reviews and planning never get them. Each applies to this
				project only.
			</p>
			<div className="flex items-start justify-between gap-3 rounded-md bg-muted/40 px-2.5 py-2">
				<div className="min-w-0 space-y-0.5">
					<label htmlFor="project-commands" className="text-xs font-medium">
						Project commands
					</label>
					<p className="text-[11px] text-muted-foreground">
						Install dependencies and run this project's own package.json scripts
						without asking, as exact commands read from package.json at each
						run. New packages are added through package.json. Never npx, node -e
						or other programs.
					</p>
					{approvals?.projectCommands &&
						approvals.projectCommandList.length > 0 && (
							<p className="break-words font-mono text-[10px] text-muted-foreground">
								{approvals.projectCommandList.join(" · ")}
							</p>
						)}
				</div>
				<Switch
					id="project-commands"
					checked={approvals?.projectCommands ?? true}
					disabled={actions.busy || !approvals}
					onCheckedChange={(enabled) => actions.onSetProjectCommands?.(enabled)}
				/>
			</div>
			{approvals && !approvals.commandsAllowed && (
				<p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-[11px]">
					Agents may not run commands at all right now (Settings → Models →
					Permissions: edits only), so these are not used.
				</p>
			)}

			{list.length > 0 && (
				<ul className="space-y-1">
					{list.map((a) => (
						<li
							key={a.id}
							className="flex items-start gap-2 rounded-md bg-muted/40 px-2 py-1.5"
							data-approval={a.rule}
						>
							<span className="mt-px shrink-0 rounded bg-background px-1.5 py-0.5 font-mono text-[10px]">
								{a.tool}
							</span>
							<div className="min-w-0 flex-1">
								<code className="block break-all font-mono text-xs">
									{a.command}
								</code>
								<span className="text-[11px] text-muted-foreground">
									{a.match === "exact"
										? "Exactly this command"
										: "This command, with extra arguments"}
									{a.cwd ? ` · asked for in ${a.cwd}` : ""}
									{a.fromTask ? ` · by ${a.fromTask}` : ""}
								</span>
							</div>
							<button
								type="button"
								className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
								onClick={() => actions.onRemoveApproval?.(a.id)}
								aria-label={`Remove approval for ${a.command}`}
								disabled={actions.busy}
							>
								<LuX className="size-3.5" aria-hidden />
							</button>
						</li>
					))}
				</ul>
			)}

			<div className="space-y-1.5">
				<div className="flex gap-1.5">
					<Select value={tool} onValueChange={(v) => setTool(v as ShellTool)}>
						<SelectTrigger className="h-8 w-[112px] text-xs" aria-label="Shell">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="Bash" className="text-xs">
								Bash
							</SelectItem>
							<SelectItem value="PowerShell" className="text-xs">
								PowerShell
							</SelectItem>
						</SelectContent>
					</Select>
					<Input
						aria-label="Command to approve"
						placeholder="npm install"
						value={command}
						onChange={(e) => setCommand(e.target.value)}
						className="h-8 font-mono text-xs"
					/>
				</div>
				<div className="flex items-center gap-1.5">
					<Select
						value={match}
						onValueChange={(v) => setMatch(v as "exact" | "prefix")}
					>
						<SelectTrigger className="h-8 flex-1 text-xs" aria-label="Scope">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="exact" className="text-xs">
								Exactly this command
							</SelectItem>
							<SelectItem value="prefix" className="text-xs">
								This command, with extra arguments
							</SelectItem>
						</SelectContent>
					</Select>
					<Button
						size="sm"
						variant="outline"
						className="h-8"
						disabled={!typed || !!problem || actions.busy}
						onClick={() => {
							actions.onApproveCommand?.({ tool, command: typed, match });
							setCommand("");
						}}
					>
						Approve
					</Button>
				</div>
				{typed &&
					(problem ? (
						<p className="text-[11px] text-destructive" role="alert">
							{problem}
						</p>
					) : (
						<p className="text-[11px] text-muted-foreground">
							Rule given to the agent:{" "}
							<code className="font-mono">
								{approvalRule({ tool, command: typed, match })}
							</code>
						</p>
					))}
			</div>
		</section>
	);
}
