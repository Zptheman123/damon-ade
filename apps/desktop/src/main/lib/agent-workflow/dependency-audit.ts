import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Dependency security, ADE's default QA step in Auto mode. ADE runs the
 * project's own package manager (no model): audit, apply the manager's
 * non-breaking fix where it has one, audit again. Only high or critical
 * advisories in production dependencies that remain block the task; the
 * rest are passed to the review as notes.
 *
 * - The fix never uses --force and never runs install scripts
 *   (--ignore-scripts).
 * - Overrides are preserved: package.json's `overrides`, `resolutions` and
 *   `pnpm.overrides` are compared before and after, and a fix that changed
 *   them is undone (manifest and lockfile restored).
 * - Managers whose fix rewrites overrides (pnpm) or that have no fix (Yarn,
 *   Bun) are audited and reported only.
 */

export type AuditPolicy = "fix" | "report" | "off";
export const AUDIT_POLICIES: AuditPolicy[] = ["fix", "report", "off"];

export type Severity = "info" | "low" | "moderate" | "high" | "critical";
const SEVERITIES: Severity[] = ["info", "low", "moderate", "high", "critical"];
const BLOCKING: Severity[] = ["high", "critical"];

export interface AuditTool {
	manager: "npm" | "pnpm" | "yarn" | "yarn-classic" | "bun";
	lockfile: string;
	audit: string;
	/** Production dependencies only (absent: not supported). */
	auditProd?: string;
	/** The manager's non-breaking fix (absent: report only). */
	fix?: string;
}

export interface Advisory {
	name: string;
	severity: Severity;
	title?: string;
	url?: string;
	/** Only in development dependencies (when the manager can tell). */
	devOnly?: boolean;
	/** What fixes it, as the manager reports it. */
	fix?: string;
}

export interface DependencyAudit {
	state: "clean" | "warnings" | "failed" | "skipped" | "unavailable";
	manager?: AuditTool["manager"];
	/** Why it was skipped or could not run. */
	reason?: string;
	counts: Record<Severity, number>;
	/** Remaining advisories, most severe first (at most 40). */
	advisories: Advisory[];
	/** Packages the manager's fix resolved. */
	fixed: string[];
	/** The commands ADE ran, in order. */
	commands: string[];
	notes: string[];
}

/** Files whose change means the dependency tree may have changed. */
export const DEPENDENCY_FILES = [
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
];

export function touchesDependencies(changedFiles: string[]): boolean {
	return changedFiles.some((file) =>
		DEPENDENCY_FILES.includes(basename(file.replace(/\\/g, "/"))),
	);
}

/** The project's package manager, from its lockfile. */
export function detectAuditTool(root: string): AuditTool | undefined {
	const has = (file: string) => existsSync(join(root, file));
	if (has("pnpm-lock.yaml")) {
		return {
			manager: "pnpm",
			lockfile: "pnpm-lock.yaml",
			audit: "pnpm audit --json",
			auditProd: "pnpm audit --json --prod",
			// `pnpm audit --fix` writes pnpm.overrides: reported only.
		};
	}
	if (has("bun.lock") || has("bun.lockb")) {
		return {
			manager: "bun",
			lockfile: has("bun.lock") ? "bun.lock" : "bun.lockb",
			audit: "bun audit --json",
		};
	}
	if (has("yarn.lock")) {
		return has(".yarnrc.yml")
			? {
					manager: "yarn",
					lockfile: "yarn.lock",
					audit: "yarn npm audit --json --recursive",
					auditProd:
						"yarn npm audit --json --recursive --environment production",
				}
			: {
					manager: "yarn-classic",
					lockfile: "yarn.lock",
					audit: "yarn audit --json",
					auditProd: "yarn audit --json --groups dependencies",
				};
	}
	const npmLock = has("npm-shrinkwrap.json")
		? "npm-shrinkwrap.json"
		: has("package-lock.json")
			? "package-lock.json"
			: undefined;
	if (npmLock) {
		return {
			manager: "npm",
			lockfile: npmLock,
			audit: "npm audit --json",
			auditProd: "npm audit --json --omit=dev",
			fix: "npm audit fix --ignore-scripts",
		};
	}
	return undefined;
}

const severity = (value: unknown): Severity => {
	const s = String(value ?? "").toLowerCase();
	return (SEVERITIES as string[]).includes(s) ? (s as Severity) : "moderate";
};

function jsonLines(text: string): unknown[] {
	const out: unknown[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// Not JSON (a progress line).
		}
	}
	return out;
}

function parseJson(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	try {
		return JSON.parse(text.slice(start)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Advisories from a manager's JSON output; undefined when unreadable. */
export function parseAudit(
	manager: AuditTool["manager"],
	output: string,
): Advisory[] | undefined {
	if (manager === "npm") {
		const data = parseJson(output);
		if (!data) return undefined;
		if (data.error && !data.vulnerabilities) return undefined;
		const vulns = (data.vulnerabilities ?? {}) as Record<
			string,
			{
				severity?: string;
				via?: Array<string | { title?: string; url?: string }>;
				fixAvailable?:
					| boolean
					| { name?: string; version?: string; isSemVerMajor?: boolean };
			}
		>;
		return Object.entries(vulns).map(([name, v]) => {
			const source = (v.via ?? []).find(
				(x): x is { title?: string; url?: string } => typeof x === "object",
			);
			const fix =
				v.fixAvailable === true
					? "npm audit fix"
					: v.fixAvailable && typeof v.fixAvailable === "object"
						? `${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? " (major upgrade)" : ""}`
						: undefined;
			return {
				name,
				severity: severity(v.severity),
				title: source?.title,
				url: source?.url,
				fix,
			};
		});
	}
	if (manager === "pnpm") {
		const data = parseJson(output);
		if (!data?.advisories) return data?.metadata ? [] : undefined;
		return Object.values(
			data.advisories as Record<
				string,
				{
					module_name?: string;
					severity?: string;
					title?: string;
					url?: string;
					patched_versions?: string;
				}
			>,
		).map((a) => ({
			name: a.module_name ?? "?",
			severity: severity(a.severity),
			title: a.title,
			url: a.url,
			fix: a.patched_versions ? `patched in ${a.patched_versions}` : undefined,
		}));
	}
	if (manager === "yarn-classic") {
		const lines = jsonLines(output) as Array<{
			type?: string;
			data?: {
				advisory?: {
					module_name?: string;
					severity?: string;
					title?: string;
					url?: string;
					patched_versions?: string;
				};
			};
		}>;
		if (
			!lines.some(
				(l) => l.type === "auditSummary" || l.type === "auditAdvisory",
			)
		) {
			return undefined;
		}
		return lines
			.filter((l) => l.type === "auditAdvisory" && l.data?.advisory)
			.map((l) => {
				const a = l.data?.advisory ?? {};
				return {
					name: a.module_name ?? "?",
					severity: severity(a.severity),
					title: a.title,
					url: a.url,
					fix: a.patched_versions
						? `patched in ${a.patched_versions}`
						: undefined,
				};
			});
	}
	if (manager === "yarn") {
		const lines = jsonLines(output) as Array<{
			value?: string;
			children?: { Severity?: string; Issue?: string; URL?: string };
		}>;
		if (!lines.length) return output.trim() ? undefined : [];
		return lines
			.filter((l) => l.value && l.children)
			.map((l) => ({
				name: String(l.value),
				severity: severity(l.children?.Severity),
				title: l.children?.Issue,
				url: l.children?.URL,
			}));
	}
	// bun: { "<package>": [{ severity, title, url, ... }] }
	const data = parseJson(output);
	if (!data) return output.trim() ? undefined : [];
	const out: Advisory[] = [];
	for (const [name, list] of Object.entries(data)) {
		if (!Array.isArray(list)) continue;
		for (const a of list as Array<{
			severity?: string;
			title?: string;
			url?: string;
		}>) {
			out.push({
				name,
				severity: severity(a.severity),
				title: a.title,
				url: a.url,
			});
		}
	}
	return out;
}

/** The overrides a manifest declares, as text to compare. */
export function overridesOf(manifest: string | undefined): string {
	if (!manifest) return "";
	try {
		const pkg = JSON.parse(manifest) as {
			overrides?: unknown;
			resolutions?: unknown;
			pnpm?: { overrides?: unknown };
		};
		return JSON.stringify([
			pkg.overrides ?? null,
			pkg.resolutions ?? null,
			pkg.pnpm?.overrides ?? null,
		]);
	} catch {
		return manifest;
	}
}

export interface AuditCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

export type RunAuditCommand = (options: {
	cwd: string;
	command: string;
	signal: AbortSignal;
}) => Promise<AuditCommandResult>;

function read(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

const emptyCounts = (): Record<Severity, number> => ({
	info: 0,
	low: 0,
	moderate: 0,
	high: 0,
	critical: 0,
});

function rank(a: Advisory): number {
	return SEVERITIES.indexOf(a.severity) * 2 + (a.devOnly ? 0 : 1);
}

/** Audit (and, with "fix", repair) the dependencies in `cwd`. */
export async function auditDependencies(options: {
	cwd: string;
	policy: AuditPolicy;
	run: RunAuditCommand;
	signal: AbortSignal;
}): Promise<DependencyAudit> {
	const { cwd, policy, run, signal } = options;
	const result: DependencyAudit = {
		state: "clean",
		counts: emptyCounts(),
		advisories: [],
		fixed: [],
		commands: [],
		notes: [],
	};
	if (policy === "off") {
		return {
			...result,
			state: "skipped",
			reason: "The dependency audit is turned off.",
		};
	}
	if (!existsSync(join(cwd, "package.json"))) {
		return {
			...result,
			state: "skipped",
			reason: "No package.json in the workspace.",
		};
	}
	const tool = detectAuditTool(cwd);
	if (!tool) {
		return {
			...result,
			state: "skipped",
			reason:
				"No lockfile, so the package manager can't audit (install dependencies to create one).",
		};
	}
	result.manager = tool.manager;

	const audit = async (command: string): Promise<Advisory[] | string> => {
		result.commands.push(command);
		const out = await run({ cwd, command, signal });
		if (out.timedOut) return `\`${command}\` timed out.`;
		const parsed = parseAudit(tool.manager, out.stdout);
		if (parsed) return parsed;
		const why = `${out.stderr}\n${out.stdout}`
			.trim()
			.split("\n")
			.slice(-3)
			.join(" ");
		return `\`${command}\` gave no readable report (exit ${out.exitCode})${why ? `: ${why.slice(0, 300)}` : ""}.`;
	};

	let advisories = await audit(tool.audit);
	if (typeof advisories === "string") {
		return { ...result, state: "unavailable", reason: advisories };
	}

	// The manager's own non-breaking fix, keeping overrides as they are.
	if (policy === "fix" && tool.fix && advisories.some((a) => a.fix)) {
		const manifestPath = join(cwd, "package.json");
		const lockPath = join(cwd, tool.lockfile);
		const manifestBefore = read(manifestPath);
		const lockBefore = read(lockPath);
		const before = new Set(advisories.map((a) => a.name));
		result.commands.push(tool.fix);
		const fix = await run({ cwd, command: tool.fix, signal });
		const manifestAfter = read(manifestPath);
		if (overridesOf(manifestAfter) !== overridesOf(manifestBefore)) {
			if (manifestBefore !== undefined)
				writeFileSync(manifestPath, manifestBefore);
			if (lockBefore !== undefined) writeFileSync(lockPath, lockBefore);
			result.notes.push(
				`\`${tool.fix}\` changed the project's overrides, so ADE undid it (package.json and ${tool.lockfile} restored).`,
			);
		} else if (fix.exitCode !== 0 && fix.exitCode !== 1) {
			result.notes.push(
				`\`${tool.fix}\` did not finish (exit ${fix.exitCode}).`,
			);
		}
		const again = await audit(tool.audit);
		if (typeof again === "string") {
			return { ...result, state: "unavailable", reason: again };
		}
		const after = new Set(again.map((a) => a.name));
		result.fixed = [...before].filter((name) => !after.has(name)).sort();
		advisories = again;
	} else if (policy === "fix" && !tool.fix && advisories.length) {
		result.notes.push(
			tool.manager === "pnpm"
				? "pnpm's fix rewrites pnpm.overrides, so ADE reports only."
				: `${tool.manager} has no automatic fix; reported only.`,
		);
	}

	// Which advisories reach production code.
	if (tool.auditProd && advisories.length) {
		const prod = await audit(tool.auditProd);
		if (typeof prod === "string") {
			result.notes.push(
				`Could not tell production from development dependencies: ${prod}`,
			);
		} else {
			const inProd = new Set(prod.map((a) => a.name));
			advisories = advisories.map((a) => ({
				...a,
				devOnly: !inProd.has(a.name),
			}));
		}
	}

	for (const a of advisories) result.counts[a.severity]++;
	result.advisories = [...advisories]
		.sort((a, b) => rank(b) - rank(a))
		.slice(0, 40);
	const blocking = advisories.filter(
		(a) => BLOCKING.includes(a.severity) && a.devOnly !== true,
	);
	result.state = blocking.length
		? "failed"
		: advisories.length
			? "warnings"
			: "clean";
	return result;
}

/** One line for people and prompts. */
export function auditSummary(audit: DependencyAudit): string {
	if (audit.state === "skipped" || audit.state === "unavailable") {
		return `Dependency audit ${audit.state}: ${audit.reason ?? ""}`.trim();
	}
	const counts = SEVERITIES.slice()
		.reverse()
		.filter((s) => audit.counts[s])
		.map((s) => `${audit.counts[s]} ${s}`)
		.join(", ");
	const fixed = audit.fixed.length
		? ` Fixed by ${audit.manager}: ${audit.fixed.join(", ")}.`
		: "";
	if (audit.state === "clean")
		return `Dependency audit (${audit.manager}): no known vulnerabilities.${fixed}`;
	return `Dependency audit (${audit.manager}): ${counts}.${fixed}`;
}

/** What a correction run is told when the audit blocks the task. */
export function auditFeedback(audit: DependencyAudit): string {
	const blocking = audit.advisories.filter(
		(a) => BLOCKING.includes(a.severity) && a.devOnly !== true,
	);
	const list = blocking
		.map(
			(a) =>
				`- ${a.name} (${a.severity})${a.title ? `: ${a.title}` : ""}${a.url ? ` ${a.url}` : ""}${a.fix ? ` — fix: ${a.fix}` : ""}`,
		)
		.join("\n");
	return `The dependency audit (${audit.manager}) found ${blocking.length} high or critical advisor${blocking.length === 1 ? "y" : "ies"} in production dependencies that its non-breaking fix could not resolve:
${list}
Resolve them with the package manager (upgrade or replace the dependency). Keep the project's existing overrides/resolutions as they are; add a new override only when no compatible upgrade exists, and say why in progress.md. Never use --force. If a fix needs a major upgrade that changes behaviour, stop and say so in progress.md instead.`;
}

/** Run one audit command (the default runner): no shell input from outside ADE. */
export function runAuditCommand(
	killTree: (pid: number) => Promise<void>,
): RunAuditCommand {
	return ({ cwd, command, signal }) =>
		new Promise((resolveRun) => {
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const child = spawn(command, {
				cwd,
				shell: true,
				windowsHide: true,
				env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
			});
			const timer = setTimeout(
				() => {
					timedOut = true;
					if (child.pid) void killTree(child.pid);
				},
				5 * 60 * 1000,
			);
			const onAbort = () => child.pid && void killTree(child.pid);
			signal.addEventListener("abort", onAbort, { once: true });
			child.stdout?.on("data", (chunk) => {
				if (stdout.length < 20_000_000) stdout += chunk;
			});
			child.stderr?.on("data", (chunk) => {
				stderr = (stderr + chunk).slice(-8000);
			});
			const done = (exitCode: number | null) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				resolveRun({ exitCode, stdout, stderr, timedOut });
			};
			child.on("error", (error) => {
				stderr += String(error);
				done(null);
			});
			child.on("close", (code) => done(code));
		});
}
