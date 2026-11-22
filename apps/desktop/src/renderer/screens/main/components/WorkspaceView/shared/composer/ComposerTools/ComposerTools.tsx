import { cn } from "@superset/ui/utils";
import {
	LuLoaderCircle,
	LuMic,
	LuMicOff,
	LuPaperclip,
	LuSquare,
	LuX,
} from "react-icons/lu";
import type { useVoiceDictation } from "../useVoiceDictation";

interface ComposerToolsProps {
	onAttach: () => void;
	voice: ReturnType<typeof useVoiceDictation>;
	disabled?: boolean;
	className?: string;
}

const button =
	"flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40";

/**
 * Beside a composer: attach files (or drop or paste them), and dictate.
 * While recording it says so plainly, with the time, Stop and Cancel; the
 * transcript lands in the draft to edit before sending.
 */
export function ComposerTools({
	onAttach,
	voice,
	disabled,
	className,
}: ComposerToolsProps) {
	const { state } = voice;
	return (
		<div
			className={cn("flex items-center gap-1", className)}
			data-composer-tools
		>
			<button
				type="button"
				className={button}
				onClick={onAttach}
				disabled={disabled}
				aria-label="Attach files"
				title="Attach files: images, PDFs, text, code, JSON, CSV (you can also drop them or paste a screenshot)"
			>
				<LuPaperclip className="size-4" aria-hidden />
			</button>
			{state.kind === "recording" ? (
				<output
					className="flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 py-0.5 pl-2 pr-0.5 text-xs text-destructive"
					aria-live="polite"
					data-voice="recording"
				>
					<span
						className="size-2 rounded-full bg-destructive"
						style={{ opacity: 0.4 + Math.min(0.6, state.level * 4) }}
						aria-hidden
					/>
					<span className="tabular-nums">
						Listening {Math.floor(state.seconds / 60)}:
						{String(state.seconds % 60).padStart(2, "0")}
					</span>
					<button
						type="button"
						onClick={() => void voice.stop()}
						className="ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-destructive/15"
						aria-label="Stop and transcribe"
					>
						<LuSquare className="size-3" aria-hidden />
						Stop
					</button>
					<button
						type="button"
						onClick={voice.cancel}
						className="rounded p-0.5 hover:bg-destructive/15"
						aria-label="Cancel recording"
					>
						<LuX className="size-3.5" aria-hidden />
					</button>
				</output>
			) : state.kind === "transcribing" || state.kind === "starting" ? (
				<output
					className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
					data-voice={state.kind}
				>
					<LuLoaderCircle className="size-3.5 animate-spin" aria-hidden />
					{state.kind === "starting"
						? "Opening the microphone…"
						: "Transcribing on this computer…"}
				</output>
			) : (
				<button
					type="button"
					className={button}
					onClick={() => void voice.start()}
					disabled={disabled || !voice.available}
					aria-label="Dictate"
					title={
						voice.available
							? `Dictate: speak, stop, then edit the text before sending (${voice.engine ?? "on this computer"})`
							: voice.unavailableReason
					}
					data-voice="idle"
				>
					{voice.available ? (
						<LuMic className="size-4" aria-hidden />
					) : (
						<LuMicOff className="size-4" aria-hidden />
					)}
				</button>
			)}
			{state.kind === "error" && (
				<span
					className="flex min-w-0 items-center gap-1 text-xs text-destructive"
					role="alert"
					data-voice="error"
				>
					<span className="truncate" title={state.message}>
						{state.message}
					</span>
					<button
						type="button"
						onClick={voice.dismiss}
						className="rounded p-0.5 hover:bg-muted"
						aria-label="Dismiss"
					>
						<LuX className="size-3" aria-hidden />
					</button>
				</span>
			)}
		</div>
	);
}
