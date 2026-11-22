import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { cn } from "@superset/ui/utils";
import { useEffect, useRef, useState } from "react";
import {
	LuCopy,
	LuExternalLink,
	LuPanelRight,
	LuPencil,
	LuPlay,
	LuRotateCw,
	LuScrollText,
	LuSquare,
	LuTrash2,
	LuTriangleAlert,
} from "react-icons/lu";
import { KIND_LABELS, LIVE, STATUS } from "../../constants";
import type { RunView, TargetView } from "../../types";

interface RunTargetCardProps {
	target: TargetView;
	run: RunView | null;
	projectType: string | null;
	/** The log, while it is shown. */
	logs?: string[];
	busy?: boolean;
	onStart: () => void;
	onStop: () => void;
	onRestart: () => void;
	onOpenPreview: (url: string) => void;
	onOpenExternal: (url: string) => void;
	onToggleLogs: () => void;
	onEdit: () => void;
	onRemove: () => void;
	onSaveArgs: (args: string) => void;
	onCopy: (text: string) => void;
}

/**
 * One run target: what it runs and where, its state, and the controls that
 * fit its kind (preview for web, a device address for mobile, arguments for
 * a command). Starting is always the user's click.
 */
export function RunTargetCard({
	target,
	run,
	projectType,
	logs,
	busy,
	onStart,
	onStop,
	onRestart,
	onOpenPreview,
	onOpenExternal,
	onToggleLogs,
	onEdit,
	onRemove,
	onSaveArgs,
	onCopy,
}: RunTargetCardProps) {
	const status = run?.status ?? "idle";
	const look = STATUS[status] ?? STATUS.idle;
	const live = LIVE.has(status);
	const url = run?.url ?? target.url;
	const canPreview =
		!!url && (target.kind === "web" || target.kind === "service" || !!run?.url);
	const webBuildOfNative =
		target.kind === "web" &&
		(projectType === "mobile-app" || projectType === "desktop-app");
	const [args, setArgs] = useState(target.args ?? "");
	useEffect(() => setArgs(target.args ?? ""), [target.args]);
	const logRef = useRef<HTMLPreElement>(null);
	useEffect(() => {
		// Follow the end of the log as it grows.
		const el = logRef.current;
		if (el && logs) el.scrollTop = el.scrollHeight;
	}, [logs]);

	return (
		<div
			className="rounded-lg border bg-card px-3 py-2.5 shadow-xs"
			data-run-target={target.id}
			data-run-status={status}
		>
			<div className="flex items-start gap-2">
				<span
					className={cn("mt-1.5 size-2 shrink-0 rounded-full", look.dot)}
					aria-hidden
				/>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-x-2">
						<span className="text-sm font-medium">{target.name}</span>
						<span className="text-[11px] text-muted-foreground">
							{webBuildOfNative
								? "Web build (not the native app)"
								: (KIND_LABELS[target.kind] ?? target.kind)}
						</span>
						<span className={cn("text-[11px] font-medium", look.text)}>
							{look.label}
							{run?.exitCode != null && !live ? ` · exit ${run.exitCode}` : ""}
						</span>
					</div>
					<code className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
						{target.command}
						{target.args ? ` ${target.args}` : ""}
						{target.cwd && target.cwd !== "." ? `  · in ${target.cwd}` : ""}
					</code>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{live ? (
						<>
							<Button
								size="sm"
								variant="outline"
								className="h-7 gap-1 px-2 text-xs"
								onClick={onRestart}
								disabled={busy || status === "stopping"}
								aria-label={`Restart ${target.name}`}
							>
								<LuRotateCw className="size-3.5" aria-hidden />
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="h-7 gap-1 px-2 text-xs"
								onClick={onStop}
								disabled={busy || status === "stopping"}
							>
								<LuSquare className="size-3" aria-hidden />
								Stop
							</Button>
						</>
					) : (
						<Button
							size="sm"
							className="h-7 gap-1 px-2.5 text-xs"
							onClick={onStart}
							disabled={busy || !target.command.trim()}
						>
							<LuPlay className="size-3" aria-hidden />
							{run ? "Run again" : "Start"}
						</Button>
					)}
				</div>
			</div>

			{target.prerequisite && (
				<p className="mt-1.5 pl-4 text-[11px] text-muted-foreground">
					Needs: {target.prerequisite}
				</p>
			)}

			{target.kind === "cli" && (
				<div className="mt-2 flex items-center gap-2 pl-4">
					<label
						htmlFor={`args-${target.id}`}
						className="shrink-0 text-[11px] text-muted-foreground"
					>
						Arguments
					</label>
					<Input
						id={`args-${target.id}`}
						value={args}
						onChange={(e) => setArgs(e.target.value)}
						onBlur={() => args !== (target.args ?? "") && onSaveArgs(args)}
						placeholder="--help"
						className="h-7 font-mono text-xs"
					/>
				</div>
			)}

			{canPreview && url && (
				<div className="mt-2 flex flex-wrap items-center gap-1.5 pl-4">
					<code className="truncate font-mono text-[11px]">{url}</code>
					<Button
						size="sm"
						variant="secondary"
						className="h-6 gap-1 px-2 text-[11px]"
						onClick={() => onOpenPreview(url)}
						disabled={status !== "ready" && status !== "running"}
					>
						<LuPanelRight className="size-3" aria-hidden />
						Open preview
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="h-6 gap-1 px-2 text-[11px]"
						onClick={() => onOpenExternal(url)}
						disabled={status !== "ready" && status !== "running"}
					>
						<LuExternalLink className="size-3" aria-hidden />
						Browser
					</Button>
				</div>
			)}

			{run?.deviceUrl && (
				<div className="mt-2 flex items-center gap-1.5 pl-4" data-device-url>
					<span className="text-[11px] text-muted-foreground">
						On a device:
					</span>
					<code className="truncate font-mono text-[11px]">
						{run.deviceUrl}
					</code>
					<button
						type="button"
						className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
						onClick={() => onCopy(run.deviceUrl ?? "")}
						aria-label="Copy the device address"
					>
						<LuCopy className="size-3" aria-hidden />
					</button>
				</div>
			)}

			{(run?.exposedWarning || (run?.error && !live) || run?.error) && (
				<p className="mt-2 flex items-start gap-1.5 pl-4 text-[11px] text-amber-700 dark:text-amber-400">
					<LuTriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
					<span>{run?.exposedWarning ?? run?.error}</span>
				</p>
			)}
			{target.lan && (
				<p className="mt-1 pl-4 text-[11px] text-muted-foreground">
					LAN access is on: devices on your network can reach this server.
				</p>
			)}

			<div className="mt-2 flex items-center gap-1 pl-3">
				<button
					type="button"
					onClick={onToggleLogs}
					disabled={!run}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
					aria-expanded={!!logs}
				>
					<LuScrollText className="size-3" aria-hidden />
					{logs ? "Hide log" : "Log"}
				</button>
				<button
					type="button"
					onClick={onEdit}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
				>
					<LuPencil className="size-3" aria-hidden />
					Edit
				</button>
				<button
					type="button"
					onClick={onRemove}
					disabled={live}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40"
				>
					<LuTrash2 className="size-3" aria-hidden />
					Remove
				</button>
			</div>

			{logs && (
				<pre
					ref={logRef}
					className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-4"
					data-run-log
				>
					{logs.length ? logs.join("\n") : "No output yet."}
				</pre>
			)}
		</div>
	);
}
