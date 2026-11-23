import { create } from "zustand";

/** Whether the Tasks panel is open (the toolbar and the activity bar open it). */
interface TasksSheetState {
	open: boolean;
	setOpen: (open: boolean) => void;
}

export const useTasksSheet = create<TasksSheetState>((set) => ({
	open: false,
	setOpen: (open) => set({ open }),
}));
