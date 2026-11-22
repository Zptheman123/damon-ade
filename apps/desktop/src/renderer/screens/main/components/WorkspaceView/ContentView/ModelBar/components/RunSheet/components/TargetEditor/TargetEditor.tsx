import { Button } from "@superset/ui/button";
import { Checkbox } from "@superset/ui/checkbox";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { useId, useState } from "react";
import { KIND_LABELS } from "../../constants";
import type { TargetKind, TargetView } from "../../types";

interface TargetEditorProps {
	initial?: TargetView;
	onSave: (target: TargetView) => void;
	onCancel: () => void;
	busy?: boolean;
}

const KINDS = Object.keys(KIND_LABELS) as TargetKind[];

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40) || "target"
	);
}

/** Add or change a run target: what to run, where, and its address. */
export function TargetEditor({
	initial,
	onSave,
	onCancel,
	busy,
}: TargetEditorProps) {
	const id = useId();
	const [name, setName] = useState(initial?.name ?? "");
	const [kind, setKind] = useState<TargetKind>(initial?.kind ?? "web");
	const [command, setCommand] = useState(initial?.command ?? "");
	const [cwd, setCwd] = useState(initial?.cwd ?? ".");
	const [url, setUrl] = useState(initial?.url ?? "");
	const [lan, setLan] = useState(!!initial?.lan);
	const urlOk =
		!url ||
		/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url);
	const valid = name.trim() && command.trim() && urlOk && !cwd.includes("..");

	return (
		<div
			className="space-y-2 rounded-lg border border-primary/30 bg-card p-3"
			data-target-editor
		>
			<div className="grid grid-cols-[1fr_140px] gap-2">
				<Input
					aria-label="Name"
					placeholder="Name (e.g. Web app)"
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="h-8 text-sm"
				/>
				<Select value={kind} onValueChange={(v) => setKind(v as TargetKind)}>
					<SelectTrigger className="h-8 text-xs" aria-label="Kind">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{KINDS.map((k) => (
							<SelectItem key={k} value={k} className="text-xs">
								{KIND_LABELS[k]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<Input
				aria-label="Command"
				placeholder="Command (e.g. bun run dev)"
				value={command}
				onChange={(e) => setCommand(e.target.value)}
				className="h-8 font-mono text-xs"
			/>
			<div className="grid grid-cols-2 gap-2">
				<Input
					aria-label="Folder"
					placeholder="Folder in the repository (.)"
					value={cwd}
					onChange={(e) => setCwd(e.target.value)}
					className="h-8 font-mono text-xs"
				/>
				<Input
					aria-label="Address"
					placeholder="Address (found in the output)"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					className="h-8 font-mono text-xs"
					aria-invalid={!urlOk}
				/>
			</div>
			{!urlOk && (
				<p className="text-[11px] text-destructive">
					The address must be on this computer (http://localhost:…).
				</p>
			)}
			<div className="flex items-start gap-2">
				<Checkbox
					id={`${id}-lan`}
					checked={lan}
					onCheckedChange={(v) => setLan(v === true)}
					className="mt-0.5"
				/>
				<label htmlFor={`${id}-lan`} className="text-[11px] leading-4">
					Allow devices on my network (LAN)
					<span className="block text-muted-foreground">
						Off: ADE asks the server to listen on this computer only. On: phones
						and other computers on your network can reach it.
					</span>
				</label>
			</div>
			<p className="text-[11px] text-muted-foreground">
				The command runs in your workspace with your permissions, only when you
				press Start.
			</p>
			<div className="flex justify-end gap-2">
				<Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					size="sm"
					className="h-7"
					disabled={!valid || busy}
					onClick={() =>
						onSave({
							...initial,
							id: initial?.id ?? `${slug(name)}-${Date.now().toString(36)}`,
							name: name.trim(),
							kind,
							command: command.trim(),
							cwd: cwd.trim() || ".",
							url: url.trim() || undefined,
							lan,
						})
					}
				>
					Save
				</Button>
			</div>
		</div>
	);
}
