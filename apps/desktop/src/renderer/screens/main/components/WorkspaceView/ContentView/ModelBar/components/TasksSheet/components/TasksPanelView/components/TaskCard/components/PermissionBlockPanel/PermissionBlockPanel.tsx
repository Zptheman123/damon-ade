import { Button } from "@superset/ui/button";
import { LuCheck, LuShieldAlert } from "react-icons/lu";
import type { TaskActions, TaskView } from "../../../../../../types";

interface PermissionBlockPanelProps {
	task: TaskView;
	block: NonNullable<TaskView["permissionBlock"]>;
	actions: TaskActions;
	disabled?: boolean;
}

/**
 * A task waiting for command approval: each refused command exactly as the
 * agent ran it, where, and what approving it allows. Approving adds a
 * project rule for implementing runs only; Resume then retries the step.
 */
export function PermissionBlockPanel({
	task,
	block,
	actions,
	disabled,
}: PermissionBlockPanelProps) {
	const anyApproved = block.operations.some((op) => op.approved);
	return (
		<div
			className="space-y-2.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5"
			data-permission-block
		>
			<div className="flex items-start gap-2">
				<LuShieldAlert
					className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
					aria-hidden
				/>
				<div className="min-w-0 space-y-0.5">
					<p className="text-xs font-medium">
						The {block.kind} step needs your approval to run{" "}
						{block.operations.length === 1 ? "a command" : "these commands"}
					</p>
					<p className="text-[11px] text-muted-foreground">
						Nothing was retried and the Architect was not called. Planning and
						earlier work are kept.
					</p>
				</div>
			</div>

			<ul className="space-y-2">
				{block.operations.map((op) => (
					<li
						key={`${op.tool}:${op.command ?? op.path ?? ""}`}
						className="space-y-1.5 rounded-md border bg-background/60 p-2"
						data-denied-operation
					>
						<div className="flex items-baseline gap-2">
							<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
								{op.tool}
							</span>
							<code className="min-w-0 break-all font-mono text-xs">
								{op.command ?? op.path ?? op.text}
							</code>
						</div>
						<p className="text-[11px] text-muted-foreground">
							In <span className="font-mono">{block.cwd}</span>
						</p>
						{op.approved ? (
							<p className="flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
								<LuCheck className="size-3" aria-hidden />
								Approved for this project
							</p>
						) : op.approvable && op.command ? (
							<div className="flex flex-wrap items-center gap-1.5">
								<Button
									size="sm"
									variant="outline"
									className="h-7 text-xs"
									disabled={disabled}
									onClick={() =>
										actions.onApproveCommand?.({
											tool: op.tool as "Bash" | "PowerShell",
											command: op.command as string,
											match: "exact",
											cwd: block.cwd,
											slug: task.slug,
										})
									}
								>
									Approve exactly this command
								</Button>
								{op.prefixAllowed && (
									<Button
										size="sm"
										variant="ghost"
										className="h-7 text-xs"
										disabled={disabled}
										title={`Also allows "${op.command} <more arguments>"`}
										onClick={() =>
											actions.onApproveCommand?.({
												tool: op.tool as "Bash" | "PowerShell",
												command: op.command as string,
												match: "prefix",
												cwd: block.cwd,
												slug: task.slug,
											})
										}
									>
										…with extra arguments
									</Button>
								)}
							</div>
						) : (
							<p className="text-[11px] text-amber-700 dark:text-amber-400">
								{op.problem} Add the parts you trust under Command approvals.
							</p>
						)}
					</li>
				))}
			</ul>

			<p className="text-[11px] text-muted-foreground">
				Approvals apply to this project's implementing runs (not reviews or
				planning) and are kept separate from the checks.
			</p>
			<div className="flex flex-wrap gap-1.5">
				<Button
					size="sm"
					disabled={disabled || !anyApproved}
					onClick={() => actions.onResume(task.slug)}
				>
					Resume: retry the {block.kind}
				</Button>
				{!anyApproved && (
					<Button
						size="sm"
						variant="ghost"
						className="text-muted-foreground"
						disabled={disabled}
						title="Runs the step again without new approvals (a paid run that may be refused again)"
						onClick={() =>
							actions.onResume(task.slug, { retryWithoutApproval: true })
						}
					>
						Retry without approving
					</Button>
				)}
			</div>
		</div>
	);
}
