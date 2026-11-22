export type TargetKind =
	| "web"
	| "service"
	| "mobile"
	| "desktop"
	| "game"
	| "cli"
	| "test"
	| "custom";

export interface TargetView {
	id: string;
	name: string;
	kind: TargetKind;
	cwd: string;
	command: string;
	url?: string;
	prerequisite?: string;
	lan?: boolean;
	args?: string;
	edited?: boolean;
}

export interface RunView {
	status: string;
	url?: string;
	deviceUrl?: string;
	exposedWarning?: string;
	exitCode?: number | null;
	error?: string;
	pid?: number;
	startedAt: string;
	command: string;
}
