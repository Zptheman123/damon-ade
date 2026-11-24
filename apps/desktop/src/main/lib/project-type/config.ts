import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { projectWorkflowFor } from "main/lib/agent-workflow/project-workflow";
import {
	PROJECT_TYPES,
	type ProjectType,
	type RunTargetKind,
	type RunTargetSuggestion,
} from "./detect";

/**
 * A team's project configuration: its type, framework and run targets. Kept
 * in ADE's record of the team (next to its tasks and specialists, moved
 * with it when the team's folder changes), never in the repository.
 * Changing the type changes defaults only; agents, tasks, attachments and
 * history are untouched.
 */

export interface RunTarget extends RunTargetSuggestion {
	/** The user edited it: detection never replaces it. */
	edited?: boolean;
	/** Let devices on the local network reach it (off: loopback only). */
	lan?: boolean;
	/** Command-line tools: arguments appended to the command. */
	args?: string;
}

export interface ProjectConfig {
	type?: ProjectType;
	framework?: string;
	/** When the user confirmed the type (unset: only suggested). */
	confirmedAt?: string;
	targets: RunTarget[];
	/** Where previews open: a tab, or split beside the conversation. */
	previewLayout?: "tab" | "split";
	/** The Vercel project (website) this team is connected to. */
	vercel?: VercelLink;
}

export interface VercelLink {
	projectId: string;
	projectName: string;
	/** The Vercel team it belongs to; null: the personal account. */
	teamId: string | null;
	linkedAt: string;
}

const FILE = "project-config.json";

function pathFor(homeDir: string, root: string): string {
	return join(projectWorkflowFor(homeDir, root).dir, FILE);
}

export function loadProjectConfig(
	homeDir: string,
	root: string,
): ProjectConfig {
	try {
		const raw = JSON.parse(
			readFileSync(pathFor(homeDir, root), "utf8"),
		) as Partial<ProjectConfig>;
		return {
			...raw,
			type: PROJECT_TYPES.includes(raw.type as ProjectType)
				? raw.type
				: undefined,
			targets: Array.isArray(raw.targets)
				? raw.targets.filter(validTarget)
				: [],
		};
	} catch {
		return { targets: [] };
	}
}

export function saveProjectConfig(
	homeDir: string,
	root: string,
	config: ProjectConfig,
): ProjectConfig {
	const path = pathFor(homeDir, root);
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
	return config;
}

export function hasProjectConfig(homeDir: string, root: string): boolean {
	return existsSync(pathFor(homeDir, root));
}

const KINDS: RunTargetKind[] = [
	"web",
	"service",
	"mobile",
	"desktop",
	"game",
	"cli",
	"test",
	"custom",
];

function validTarget(t: unknown): t is RunTarget {
	const v = t as RunTarget;
	return (
		!!v &&
		typeof v.id === "string" &&
		typeof v.name === "string" &&
		typeof v.command === "string" &&
		typeof v.cwd === "string" &&
		KINDS.includes(v.kind)
	);
}

/**
 * Add detected targets the user does not have yet; targets the user edited
 * (or removed by editing) are never replaced.
 */
export function mergeTargets(
	current: RunTarget[],
	suggested: RunTargetSuggestion[],
): RunTarget[] {
	const ids = new Set(current.map((t) => t.id));
	return [...current, ...suggested.filter((s) => !ids.has(s.id))];
}
