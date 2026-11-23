import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectWorkflow } from "./project-workflow";
import type { CheckResult } from "./tasks";

/**
 * Checks are the project's own commands (typecheck, lint, tests), run by ADE
 * itself after implementation. A task is only done when they pass, so
 * completion never rests on a model saying it ran them. The commands are
 * suggested from the project but only used once the user approves them; they
 * are stored in the project's ADE folder, never in the project.
 */

export interface ProjectChecks {
	commands: string[];
	/** Set when the user approved these commands. */
	approvedAt?: string;
}

const CHECKS_FILE = "checks.json";
const MAX_COMMANDS = 10;
const MAX_COMMAND_LENGTH = 500;
export const CHECK_TIMEOUT_MS = 15 * 60 * 1000;

export function loadProjectChecks(project: ProjectWorkflow): ProjectChecks {
	try {
		const parsed = JSON.parse(
			readFileSync(join(project.dir, CHECKS_FILE), "utf8"),
		) as Partial<ProjectChecks>;
		const commands = Array.isArray(parsed.commands)
			? parsed.commands.filter((c): c is string => typeof c === "string")
			: [];
		return {
			commands,
			approvedAt:
				typeof parsed.approvedAt === "string" ? parsed.approvedAt : undefined,
		};
	} catch {
		return { commands: [] };
	}
}

/** Save and approve the commands (the user confirmed them). */
export function saveProjectChecks(
	project: ProjectWorkflow,
	commands: string[],
	now: Date = new Date(),
): ProjectChecks {
	const cleaned = commands.map((c) => c.trim()).filter(Boolean);
	if (cleaned.length > MAX_COMMANDS) {
		throw new Error(`At most ${MAX_COMMANDS} check commands`);
	}
	for (const command of cleaned) {
		if (command.length > MAX_COMMAND_LENGTH || /[\r\n\0]/.test(command)) {
			throw new Error("A check command must be one line");
		}
	}
	const checks: ProjectChecks = {
		commands: cleaned,
		approvedAt: now.toISOString(),
	};
	const path = join(project.dir, CHECKS_FILE);
	writeFileSync(`${path}.tmp`, `${JSON.stringify(checks, null, 2)}\n`, "utf8");
	renameSync(`${path}.tmp`, path);
	return checks;
}

/**
 * Suggested checks, read from the project's own config (never run): the
 * package.json scripts named typecheck, lint and test, with its package
 * manager. Only suggestions; nothing runs until the user approves.
 */
export function suggestChecks(root: string): string[] {
	let scripts: Record<string, unknown> = {};
	try {
		scripts =
			(
				JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
					scripts?: Record<string, unknown>;
				}
			).scripts ?? {};
	} catch {
		return [];
	}
	const runner =
		existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))
			? "bun run"
			: existsSync(join(root, "pnpm-lock.yaml"))
				? "pnpm run"
				: existsSync(join(root, "yarn.lock"))
					? "yarn"
					: "npm run";
	const usable = (name: string) =>
		typeof scripts[name] === "string" &&
		// A build that packages an installer or publishes is not a check.
		!(name === "build" && PACKAGES.test(scripts[name] as string));
	// Build after typecheck: an app that does not build is not done (the
	// Test App's checks never ran its build).
	return ["typecheck", "build", "lint", "test"]
		.filter(usable)
		.map((name) => `${runner} ${name}`);
}

const PACKAGES =
	/electron-builder|electron-forge|\bforge\s+(make|publish)|tauri\s+build|\beas\s|--publish|\bpublish\b|docker\s+(build|push)|\bpkg\b|nexe/i;

export type SpawnFn = typeof spawn;

export interface RunChecksOptions {
	cwd: string;
	commands: string[];
	/** Shell to run each command line with, e.g. ["bash", "-c"]. */
	shell: string[];
	spawnFn?: SpawnFn;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Kill a process and its children. */
	killTree: (pid: number) => Promise<void>;
	/**
	 * Commands whose failure does not stop the rest (checks that already
	 * failed before the task changed anything).
	 */
	continuePast?: string[];
}

function tail(text: string, max = 4000): string {
	return text.length > max ? text.slice(-max) : text;
}

/** Run each check command in order; stops at the first failure (except continuePast). */
export async function runChecks(
	options: RunChecksOptions,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const spawnFn = options.spawnFn ?? spawn;
	for (const command of options.commands) {
		if (options.signal?.aborted) break;
		const started = Date.now();
		const result = await new Promise<CheckResult>((resolveResult) => {
			let output = "";
			let timedOut = false;
			let child: ChildProcess;
			try {
				child = spawnFn(
					options.shell[0],
					[...options.shell.slice(1), command],
					{
						cwd: options.cwd,
						windowsHide: true,
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
			} catch (error) {
				resolveResult({
					command,
					exitCode: null,
					timedOut: false,
					durationMs: 0,
					outputTail: String(error),
				});
				return;
			}
			const stop = () => {
				if (child.pid) void options.killTree(child.pid);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, options.timeoutMs ?? CHECK_TIMEOUT_MS);
			options.signal?.addEventListener("abort", stop, { once: true });
			child.stdout?.on("data", (chunk) => {
				output = tail(output + chunk);
			});
			child.stderr?.on("data", (chunk) => {
				output = tail(output + chunk);
			});
			const finish = (exitCode: number | null, extra = "") => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", stop);
				resolveResult({
					command,
					exitCode,
					timedOut,
					durationMs: Date.now() - started,
					outputTail: tail(output + extra),
				});
			};
			child.on("error", (error) => finish(null, `\n${String(error)}`));
			child.on("close", (code) => finish(code));
		});
		results.push(result);
		if (result.exitCode !== 0 && !options.continuePast?.includes(command))
			break;
	}
	return results;
}

export function checksPassed(
	results: CheckResult[],
	expected: number,
): boolean {
	return (
		results.length === expected &&
		results.every((result) => result.exitCode === 0 && !result.timedOut)
	);
}

/**
 * The checks a task is verified with. What the user saved always wins (an
 * empty saved list means "no checks"). Never configured: the project's own
 * typecheck, lint and test scripts, read from the task's folder, so Auto
 * verifies with real commands instead of only with a model's opinion.
 */
export function effectiveChecks(
	project: ProjectWorkflow,
	worktree: string,
	auto: boolean,
): { commands: string[]; source: "approved" | "auto" | "none" } {
	const saved = loadProjectChecks(project);
	if (saved.approvedAt) {
		return {
			commands: saved.commands,
			source: saved.commands.length ? "approved" : "none",
		};
	}
	if (!auto) return { commands: [], source: "none" };
	const suggested = suggestChecks(worktree);
	return suggested.length
		? { commands: suggested, source: "auto" }
		: { commands: [], source: "none" };
}
