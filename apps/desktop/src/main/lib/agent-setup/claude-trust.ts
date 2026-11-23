import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Claude Code asks, in every new session, whether to trust a folder given
 * with --add-dir ("Adding a new directory: ... Yes, add it"); that answer
 * lasts for the session only. ADE adds its own task folder to agents'
 * sessions, so the question came back each time. A folder's trust is
 * recorded in ~/.claude.json as projects[<folder>].hasTrustDialogAccepted,
 * which is what Claude Code itself documents for this (and what trusting a
 * folder you start Claude Code in records).
 *
 * ADE records it only for folders it creates and owns (a team's task
 * folder: plans and notes, no project code), changes nothing else in the
 * file, and never for a folder that contains a .claude directory (which
 * could carry commands, agents or settings into trusted sessions).
 */

export type TrustResult = "trusted" | "already" | "skipped";

/** The key Claude Code uses: forward slashes, upper-case drive letter. */
export function claudeProjectKey(dir: string): string {
	const full = resolve(dir).replace(/\\/g, "/").replace(/\/+$/, "");
	return full.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
}

export function trustFolderForClaude(
	dir: string,
	configPath: string = join(homedir(), ".claude.json"),
): TrustResult {
	if (!existsSync(dir) || existsSync(join(dir, ".claude"))) return "skipped";
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch {
		// Claude Code has not run yet on this computer: nothing to record into.
		return "skipped";
	}
	let config: { projects?: Record<string, Record<string, unknown>> };
	try {
		config = JSON.parse(raw);
	} catch {
		// Never rewrite a file we cannot read.
		return "skipped";
	}
	const key = claudeProjectKey(dir);
	const projects = config.projects ?? {};
	if (projects[key]?.hasTrustDialogAccepted === true) return "already";
	projects[key] = { ...(projects[key] ?? {}), hasTrustDialogAccepted: true };
	config.projects = projects;
	const tmp = `${configPath}.ade-${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tmp, configPath);
	return "trusted";
}
