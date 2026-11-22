import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import type { RunTarget } from "main/lib/project-type/config";

/**
 * Runs a team's run targets (dev servers, apps, games, commands) as
 * processes ADE owns. Nothing starts unless the user presses Start; ADE
 * keeps one process per target and workspace, collects its output, finds
 * the address it prints, checks it answers, and stops the whole process
 * tree. State lives in memory only: after ADE restarts, nothing is assumed
 * to be running.
 */

export type RunStatus =
	| "starting"
	| "ready"
	| "running"
	| "stopping"
	| "exited"
	| "failed"
	| "stopped";

export interface RunState {
	key: string;
	workspaceId: string;
	targetId: string;
	name: string;
	kind: RunTarget["kind"];
	status: RunStatus;
	command: string;
	cwd: string;
	pid?: number;
	/** The local address the server answers on. */
	url?: string;
	/** An Expo / React Native address for a device (exp://…). */
	deviceUrl?: string;
	/** The server says it is reachable from the network although LAN is off. */
	exposedWarning?: string;
	lan: boolean;
	startedAt: string;
	endedAt?: string;
	exitCode?: number | null;
	error?: string;
}

export interface RunEvent {
	type: "state" | "log";
	state: RunState;
	lines?: string[];
}

export interface RunManagerDeps {
	spawn?: typeof nodeSpawn;
	/** Whether an address answers (any HTTP status counts). */
	probe?: (url: string) => Promise<boolean>;
	killTree?: (pid: number) => Promise<void>;
	readyTimeoutMs?: number;
	probeIntervalMs?: number;
}

const MAX_LOG_LINES = 2000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape codes are control characters.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const LOCAL_URL =
	/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|(?:\d{1,3}\.){3}\d{1,3}):\d{2,5}(?:\/[^\s'"`)\]]*)?/gi;
const DEVICE_URL = /\bexps?:\/\/[^\s'"`)\]]+/i;

function isLoopbackHost(host: string): boolean {
	return (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "[::1]" ||
		host === "::1"
	);
}

/** The addresses a line mentions, made usable from this computer. */
export function urlsIn(line: string): { local: string[]; exposed: string[] } {
	const local: string[] = [];
	const exposed: string[] = [];
	for (const match of line.match(LOCAL_URL) ?? []) {
		const url = match.replace(/[.,;:]+$/, "");
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			continue;
		}
		if (isLoopbackHost(parsed.hostname)) {
			local.push(url);
		} else if (parsed.hostname === "0.0.0.0") {
			// Listening on every interface: use it locally, and note the exposure.
			exposed.push(url);
			local.push(url.replace("0.0.0.0", "localhost"));
		} else {
			exposed.push(url);
		}
	}
	return { local, exposed };
}

/** A target's folder, which must stay inside the workspace. */
export function targetCwd(worktree: string, cwd: string): string {
	const full = resolve(worktree, cwd || ".");
	const rel = relative(worktree, full);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`The folder "${cwd}" is outside this workspace.`);
	}
	return full;
}

/** Whether an address is on this computer (what previews may open). */
export function isLocalUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			isLoopbackHost(parsed.hostname)
		);
	} catch {
		return false;
	}
}

export function defaultProbe(url: string): Promise<boolean> {
	return new Promise((done) => {
		try {
			const req = httpRequest(url, { method: "GET", timeout: 2000 }, (res) => {
				res.resume();
				done(true);
			});
			req.on("error", () => done(false));
			req.on("timeout", () => {
				req.destroy();
				done(false);
			});
			req.end();
		} catch {
			done(false);
		}
	});
}

interface Run {
	state: RunState;
	child?: ChildProcess;
	logs: string[];
	partial: string;
	probing?: ReturnType<typeof setInterval>;
	readyTimer?: ReturnType<typeof setTimeout>;
	stopRequested?: boolean;
}

export class RunManager extends EventEmitter {
	private runs = new Map<string, Run>();
	private spawnFn: typeof nodeSpawn;
	private probe: (url: string) => Promise<boolean>;
	private killTree: (pid: number) => Promise<void>;
	private readyTimeoutMs: number;
	private probeIntervalMs: number;

	constructor(deps: RunManagerDeps = {}) {
		super();
		this.setMaxListeners(100);
		this.spawnFn = deps.spawn ?? nodeSpawn;
		this.probe = deps.probe ?? defaultProbe;
		this.killTree =
			deps.killTree ??
			(async (pid) => {
				const { treeKillWithEscalation } = await import("main/lib/tree-kill");
				await treeKillWithEscalation({ pid, escalationTimeoutMs: 3000 });
			});
		this.readyTimeoutMs = deps.readyTimeoutMs ?? 120_000;
		this.probeIntervalMs = deps.probeIntervalMs ?? 1000;
	}

	static keyOf(workspaceId: string, targetId: string): string {
		return `${workspaceId}::${targetId}`;
	}

	list(workspaceId: string): RunState[] {
		return [...this.runs.values()]
			.filter((r) => r.state.workspaceId === workspaceId)
			.map((r) => ({ ...r.state }));
	}

	get(workspaceId: string, targetId: string): RunState | undefined {
		const run = this.runs.get(RunManager.keyOf(workspaceId, targetId));
		return run ? { ...run.state } : undefined;
	}

	logs(workspaceId: string, targetId: string): string[] {
		const run = this.runs.get(RunManager.keyOf(workspaceId, targetId));
		if (!run) return [];
		return run.partial ? [...run.logs, run.partial] : [...run.logs];
	}

	private isLive(run: Run | undefined): boolean {
		return (
			!!run &&
			(run.state.status === "starting" ||
				run.state.status === "ready" ||
				run.state.status === "running" ||
				run.state.status === "stopping")
		);
	}

	/** Start a target; a target already running is returned as it is. */
	start(input: {
		workspaceId: string;
		worktree: string;
		target: RunTarget;
	}): RunState {
		const { workspaceId, worktree, target } = input;
		const key = RunManager.keyOf(workspaceId, target.id);
		const existing = this.runs.get(key);
		if (existing && this.isLive(existing)) return { ...existing.state };
		if (!target.command.trim()) {
			throw new Error(`"${target.name}" has no command to run.`);
		}
		const cwd = targetCwd(worktree, target.cwd);
		const command = target.args?.trim()
			? `${target.command} ${target.args.trim()}`
			: target.command;
		const lan = !!target.lan;
		const run: Run = {
			logs: [],
			partial: "",
			state: {
				key,
				workspaceId,
				targetId: target.id,
				name: target.name,
				kind: target.kind,
				status: "starting",
				command,
				cwd,
				lan,
				url: target.url && isLocalUrl(target.url) ? target.url : undefined,
				startedAt: new Date().toISOString(),
			},
		};
		this.runs.set(key, run);
		this.push(run, [`$ ${command}`, `  in ${cwd}`]);

		let child: ChildProcess;
		try {
			child = this.spawnFn(command, {
				cwd,
				shell: true,
				windowsHide: true,
				detached: process.platform !== "win32",
				env: {
					...process.env,
					// Ask servers to stay on this computer unless LAN is on;
					// frameworks that ignore it are flagged when they print a
					// network address.
					HOST: lan ? "0.0.0.0" : "127.0.0.1",
					HOSTNAME: lan ? "0.0.0.0" : "127.0.0.1",
					BROWSER: "none",
					NO_COLOR: "1",
					FORCE_COLOR: "0",
					CI: process.env.CI ?? "",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			this.finish(run, null, (error as Error).message);
			return { ...run.state };
		}
		run.child = child;
		run.state.pid = child.pid;
		const onData = (chunk: Buffer) => this.output(run, chunk.toString("utf8"));
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (error) => this.finish(run, null, error.message));
		child.on("exit", (code) => this.finish(run, code));

		if (target.kind === "web" || target.kind === "service" || run.state.url) {
			this.watchReady(run);
		} else {
			run.state.status = "running";
		}
		this.emitState(run);
		return { ...run.state };
	}

	async stop(
		workspaceId: string,
		targetId: string,
	): Promise<RunState | undefined> {
		const run = this.runs.get(RunManager.keyOf(workspaceId, targetId));
		if (!run) return undefined;
		if (!this.isLive(run) || !run.child?.pid) return { ...run.state };
		run.stopRequested = true;
		run.state.status = "stopping";
		this.emitState(run);
		this.clearTimers(run);
		try {
			await this.killTree(run.child.pid);
		} catch {
			// It may already be gone.
		}
		return { ...run.state };
	}

	async restart(input: {
		workspaceId: string;
		worktree: string;
		target: RunTarget;
	}): Promise<RunState> {
		const run = this.runs.get(
			RunManager.keyOf(input.workspaceId, input.target.id),
		);
		if (run && this.isLive(run)) {
			await this.stop(input.workspaceId, input.target.id);
			await this.exited(run);
		}
		return this.start(input);
	}

	/** Stop everything ADE started (on quit, or a workspace closing). */
	async stopAll(workspaceId?: string): Promise<void> {
		await Promise.all(
			[...this.runs.values()]
				.filter((r) => !workspaceId || r.state.workspaceId === workspaceId)
				.map((r) => this.stop(r.state.workspaceId, r.state.targetId)),
		);
	}

	private exited(run: Run): Promise<void> {
		if (!this.isLive(run)) return Promise.resolve();
		return new Promise((done) => {
			const check = (event: RunEvent) => {
				if (
					event.type === "state" &&
					event.state.key === run.state.key &&
					!this.isLive(run)
				) {
					this.off("event", check);
					done();
				}
			};
			this.on("event", check);
			setTimeout(() => {
				this.off("event", check);
				done();
			}, 10_000);
		});
	}

	private output(run: Run, text: string) {
		const clean = (run.partial + text)
			.replace(ANSI, "")
			.replace(/\r(?!\n)/g, "\n");
		const parts = clean.split(/\r?\n/);
		run.partial = parts.pop() ?? "";
		if (run.partial.length > 4000) {
			parts.push(run.partial);
			run.partial = "";
		}
		if (!parts.length) return;
		for (const line of parts) this.scan(run, line);
		this.push(run, parts);
	}

	private scan(run: Run, line: string) {
		const { local, exposed } = urlsIn(line);
		if (!run.state.url && local.length) {
			run.state.url = local[0];
			if (run.state.status === "running" || run.state.status === "starting") {
				this.watchReady(run);
			}
		}
		if (exposed.length && !run.state.lan && !run.state.exposedWarning) {
			run.state.exposedWarning = `The server says it is reachable from your network (${exposed[0]}) although LAN access is off. Its framework ignored ADE's request to stay on this computer; set it to listen on localhost (for example --host 127.0.0.1).`;
			this.emitState(run);
		}
		if (!run.state.deviceUrl) {
			const device = line.match(DEVICE_URL);
			if (device) {
				run.state.deviceUrl = device[0].replace(/[.,;:]+$/, "");
				this.emitState(run);
			}
		}
	}

	private push(run: Run, lines: string[]) {
		run.logs.push(...lines);
		if (run.logs.length > MAX_LOG_LINES) {
			run.logs.splice(0, run.logs.length - MAX_LOG_LINES);
		}
		this.emit("event", {
			type: "log",
			state: { ...run.state },
			lines,
		} satisfies RunEvent);
	}

	private watchReady(run: Run) {
		if (run.probing) return;
		run.readyTimer ??= setTimeout(() => {
			if (run.state.status === "starting") {
				run.state.status = "running";
				run.state.error = run.state.url
					? `${run.state.url} did not answer within ${Math.round(this.readyTimeoutMs / 1000)} s. The process is still running: check its log.`
					: "No local address appeared in the output. If this is a server, set its address in the target.";
				this.emitState(run);
			}
			if (run.probing) clearInterval(run.probing);
			run.probing = undefined;
		}, this.readyTimeoutMs);
		if (!run.state.url) return;
		let busy = false;
		run.probing = setInterval(async () => {
			if (busy || !run.state.url) return;
			busy = true;
			const ok = await this.probe(run.state.url);
			busy = false;
			if (ok && this.isLive(run) && run.state.status !== "stopping") {
				run.state.status = "ready";
				run.state.error = undefined;
				this.clearTimers(run);
				this.emitState(run);
			}
		}, this.probeIntervalMs);
	}

	private clearTimers(run: Run) {
		if (run.probing) clearInterval(run.probing);
		if (run.readyTimer) clearTimeout(run.readyTimer);
		run.probing = undefined;
		run.readyTimer = undefined;
	}

	private finish(run: Run, code: number | null, error?: string) {
		if (!this.isLive(run) && run.state.endedAt) return;
		this.clearTimers(run);
		if (run.partial) {
			this.push(run, [run.partial]);
			run.partial = "";
		}
		run.state.exitCode = code;
		run.state.endedAt = new Date().toISOString();
		if (run.stopRequested) {
			run.state.status = "stopped";
		} else if (error || (code !== 0 && code !== null)) {
			run.state.status = "failed";
			run.state.error =
				error ??
				`Exited with code ${code}.${/not recognized|not found|ENOENT/i.test(run.logs.slice(-20).join("\n")) ? " A program it needs may not be installed." : ""}`;
		} else {
			run.state.status = "exited";
		}
		this.push(run, [
			run.state.status === "stopped"
				? "— stopped —"
				: `— exited${code === null ? "" : ` with code ${code}`} —`,
		]);
		this.emitState(run);
	}

	private emitState(run: Run) {
		this.emit("event", {
			type: "state",
			state: { ...run.state },
		} satisfies RunEvent);
	}
}

let manager: RunManager | undefined;

export function getRunManager(): RunManager {
	manager ??= new RunManager();
	return manager;
}
