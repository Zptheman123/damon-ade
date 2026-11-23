import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Handing work from one agent to another in a team request. Agents work in
 * their own worktrees of the team's repository, on their own branches. When
 * a subtask depends on one another agent finished, ADE commits that
 * subtask's own files on its agent's branch and merges the commit into the
 * dependent agent's branch before it starts. Nothing else is committed,
 * nothing is pushed, and the team's main branch is never merged into.
 */

function git(
	cwd: string,
	args: string[],
): { ok: boolean; out: string; err: string } {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
	});
	return {
		ok: result.status === 0,
		out: (result.stdout ?? "").trim(),
		err: (result.stderr || result.stdout || result.error?.message || "").trim(),
	};
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim()) ?? "git failed";
}

/**
 * Files that are never handed from one agent to another: build output and
 * caches (each folder rebuilds its own; committing them makes the next
 * merge collide with that folder's copy) and private files (credentials,
 * local configuration). Paths use forward slashes.
 */
const GENERATED = [
	/(^|\/)node_modules\//,
	/(^|\/)(dist|out|build|release|coverage|\.turbo|\.next|\.nuxt|\.cache|\.vite|\.parcel-cache)\//,
	/\.tsbuildinfo$/,
	/\.log$/,
	/(^|\/)(\.DS_Store|Thumbs\.db)$/,
];
const PRIVATE = [
	/(^|\/)\.env(\.(?!example$|sample$|template$)[^/]+)?$/,
	/\.(pem|key|p12|pfx|keystore|jks)$/i,
	/(^|\/)\.npmrc$/,
	/(^|\/)\.claude\/settings\.local\.json$/,
];

export function isGenerated(path: string): boolean {
	const p = path.replace(/\\/g, "/");
	return GENERATED.some((re) => re.test(p));
}

/** What a handoff commits from a task's changed files, and what it leaves. */
export function handoffFiles(files: string[]): {
	files: string[];
	skipped: Array<{ path: string; why: "generated" | "private" }>;
} {
	const kept: string[] = [];
	const skipped: Array<{ path: string; why: "generated" | "private" }> = [];
	for (const file of files) {
		const p = file.replace(/\\/g, "/");
		if (PRIVATE.some((re) => re.test(p)))
			skipped.push({ path: file, why: "private" });
		else if (isGenerated(p)) skipped.push({ path: file, why: "generated" });
		else kept.push(file);
	}
	return { files: kept, skipped };
}

/**
 * Commit exactly these files (a finished subtask's own changes) on the
 * worktree's current branch. Returns the commit, or why it failed.
 */
export function commitFiles(
	worktree: string,
	files: string[],
	message: string,
): { commit: string } | { error: string } {
	if (files.length === 0) return { error: "no files to commit" };
	const add = git(worktree, ["add", "-A", "--", ...files]);
	if (!add.ok) return { error: firstLine(add.err) };
	const commit = git(worktree, [
		"commit",
		"--no-verify",
		"-m",
		message,
		"--",
		...files,
	]);
	if (!commit.ok) return { error: firstLine(commit.err) };
	const head = git(worktree, ["rev-parse", "HEAD"]);
	return head.ok ? { commit: head.out } : { error: firstLine(head.err) };
}

function lines(text: string): string[] {
	return text.split("\0").filter(Boolean);
}

/**
 * Whether the file in the folder is the same as the commit's: compared as
 * git would store it (line endings and filters applied), so a checkout's
 * CRLF copy of an LF file counts as identical.
 */
function sameBlob(worktree: string, commit: string, path: string): boolean {
	const theirs = git(worktree, ["rev-parse", `${commit}:${path}`]);
	const mine = git(worktree, ["hash-object", `--path=${path}`, "--", path]);
	return theirs.ok && mine.ok && theirs.out === mine.out;
}

/** Move a file, also across drives: copy, check the copy, then remove. */
function moveFile(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	try {
		renameSync(from, to);
	} catch {
		copyFileSync(from, to);
		if (!readFileSync(from).equals(readFileSync(to))) {
			throw new Error(`Could not copy ${from} safely`);
		}
		rmSync(from);
	}
}

export interface MovedAside {
	path: string;
	why: "identical" | "generated";
	/** Where ADE kept the destination's copy (outside the repository). */
	backup: string;
}

export type IntegrateResult =
	| { status: "merged"; movedAside: MovedAside[] }
	| { status: "already-in"; movedAside: MovedAside[] }
	| {
			status: "needs-decision";
			/** Untracked files here that the incoming work also creates, with other contents. */
			paths: string[];
			explanation: string;
	  }
	| { status: "conflict"; paths: string[]; explanation: string }
	| { status: "error"; explanation: string };

/**
 * Bring a commit into the worktree's branch without losing anything.
 *
 * - Already there (an earlier handoff): nothing to do.
 * - The incoming commit creates files this folder has as untracked (or
 *   ignored) files: each is compared byte for byte. Identical copies and
 *   generated files (build caches) are moved to `backupDir`, outside the
 *   repository, so the merge can write them; nothing is deleted. A file
 *   with other contents that is not generated is the user's or an agent's
 *   work: ADE stops and names it (needs-decision), touching nothing.
 * - A merge conflict is undone and the conflicting paths returned; files
 *   moved aside are put back.
 */
export function integrateCommit(
	worktree: string,
	commit: string,
	message: string,
	backupDir: string,
): IntegrateResult {
	const isAncestor = spawnSync(
		"git",
		["merge-base", "--is-ancestor", commit, "HEAD"],
		{ cwd: worktree, windowsHide: true },
	);
	if (isAncestor.status === 0) return { status: "already-in", movedAside: [] };

	const base = git(worktree, ["merge-base", "HEAD", commit]);
	const incoming = git(
		worktree,
		base.ok && base.out
			? ["diff", "--name-only", "-z", "--diff-filter=AMRC", base.out, commit]
			: ["ls-tree", "-r", "--name-only", "-z", commit],
	);
	if (!incoming.ok)
		return { status: "error", explanation: firstLine(incoming.err) };
	const untracked = new Set([
		...lines(
			git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]).out,
		),
		...lines(
			git(worktree, [
				"ls-files",
				"--others",
				"--ignored",
				"--exclude-standard",
				"-z",
			]).out,
		),
	]);

	const moveAside: Array<{ path: string; why: MovedAside["why"] }> = [];
	const different: string[] = [];
	for (const path of lines(incoming.out)) {
		if (!untracked.has(path)) continue;
		if (sameBlob(worktree, commit, path))
			moveAside.push({ path, why: "identical" });
		else if (isGenerated(path)) moveAside.push({ path, why: "generated" });
		else different.push(path);
	}
	if (different.length) {
		return {
			status: "needs-decision",
			paths: different,
			explanation: `This folder has files that are not committed, and the incoming work creates the same files with different contents: ${different.join(", ")}. ADE has not changed them. Keep yours by committing them in this folder (then Resume to merge and resolve), or move them out of the folder (then Resume to take the incoming versions).`,
		};
	}

	const movedAside: MovedAside[] = [];
	for (const { path, why } of moveAside) {
		const backup = join(backupDir, path);
		moveFile(join(worktree, path), backup);
		movedAside.push({ path, why, backup });
	}
	const merge = git(worktree, ["merge", "--no-edit", "-m", message, commit]);
	if (merge.ok) return { status: "merged", movedAside };

	const conflicted = git(worktree, ["diff", "--name-only", "--diff-filter=U"]);
	git(worktree, ["merge", "--abort"]);
	// Put back what was moved aside: the folder is as it was.
	for (const moved of movedAside) {
		if (!existsSync(join(worktree, moved.path))) {
			moveFile(moved.backup, join(worktree, moved.path));
		}
	}
	const paths =
		conflicted.ok && conflicted.out ? conflicted.out.split("\n") : [];
	return paths.length
		? {
				status: "conflict",
				paths,
				explanation: `Both agents changed the same lines in ${paths.join(", ")}. ADE undid the merge, so this folder is as it was. Resolve it in this folder (git merge ${commit.slice(0, 7)}, fix the marked lines, commit), then Resume.`,
			}
		: { status: "error", explanation: firstLine(merge.err) };
}

/**
 * Merge a commit into the worktree's branch. On a conflict the merge is
 * undone and the reason returned; the worktree is left as it was.
 */
export function mergeCommit(
	worktree: string,
	commit: string,
	message: string,
): string | undefined {
	const merge = git(worktree, ["merge", "--no-edit", "-m", message, commit]);
	if (merge.ok) return undefined;
	const conflicted = git(worktree, ["diff", "--name-only", "--diff-filter=U"]);
	git(worktree, ["merge", "--abort"]);
	return conflicted.ok && conflicted.out
		? `merge conflict in ${conflicted.out.split("\n").join(", ")}`
		: firstLine(merge.err);
}
