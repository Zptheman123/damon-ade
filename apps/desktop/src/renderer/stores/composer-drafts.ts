import { create } from "zustand";

/**
 * Unsent attachments per composer (a workspace's Tasks form, Team plans,
 * a Claude Code tab), so closing a panel or switching tabs keeps them.
 * In memory for this run of ADE; the files themselves are ADE's copies.
 */

export interface DraftAttachment {
	/** Local id while uploading; the attachment's id once ready. */
	key: string;
	name: string;
	status: "adding" | "ready" | "error";
	error?: string;
	attachment?: {
		id: string;
		name: string;
		kind: string;
		mime: string;
		size: number;
		path: string;
		access: string;
		preview: string | null;
	};
}

interface ComposerDraftsState {
	drafts: Record<string, DraftAttachment[]>;
	set: (surface: string, items: DraftAttachment[]) => void;
	update: (
		surface: string,
		fn: (items: DraftAttachment[]) => DraftAttachment[],
	) => void;
}

export const useComposerDrafts = create<ComposerDraftsState>((set) => ({
	drafts: {},
	set: (surface, items) =>
		set((state) => ({ drafts: { ...state.drafts, [surface]: items } })),
	update: (surface, fn) =>
		set((state) => ({
			drafts: { ...state.drafts, [surface]: fn(state.drafts[surface] ?? []) },
		})),
}));
