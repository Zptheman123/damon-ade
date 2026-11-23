import { Button } from "@superset/ui/button";
import { Textarea } from "@superset/ui/textarea";
import { useState } from "react";
import { LuNotebookPen } from "react-icons/lu";
import type { TaskActions, TaskView } from "../../../../../../types";

interface TaskNotesProps {
	task: TaskView;
	actions: TaskActions;
	disabled?: boolean;
}

/**
 * Notes for the agent on a task that has not finished: added to its
 * description, so the next run (and every run after) reads them. Useful for
 * items left over from an earlier subtask before this one starts.
 */
export function TaskNotes({ task, actions, disabled }: TaskNotesProps) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const notes = task.notes ?? [];

	return (
		<div className="space-y-1.5" data-task-notes>
			{notes.length > 0 && (
				<div className="space-y-1 rounded-md bg-muted/40 px-2.5 py-1.5">
					<p className="text-[11px] font-medium text-muted-foreground">
						Your notes ({notes.length}) · later runs read them
					</p>
					{notes.map((note) => (
						<p
							key={note.at}
							className="whitespace-pre-wrap break-words text-xs"
						>
							{note.text}
						</p>
					))}
				</div>
			)}
			{open ? (
				<div className="space-y-1.5">
					<Textarea
						aria-label="Notes for the agent"
						rows={4}
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder="Anything the agent should also do or keep in mind, e.g. items left over from an earlier subtask"
						className="text-xs"
					/>
					<div className="flex gap-1.5">
						<Button
							size="sm"
							disabled={disabled || !text.trim()}
							onClick={() => {
								actions.onAddNotes?.(task.slug, text.trim());
								setText("");
								setOpen(false);
							}}
						>
							Add notes
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
					</div>
				</div>
			) : (
				<button
					type="button"
					onClick={() => setOpen(true)}
					disabled={disabled}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
				>
					<LuNotebookPen className="size-3" aria-hidden />
					{notes.length ? "Add more notes" : "Add notes for the agent"}
				</button>
			)}
		</div>
	);
}
