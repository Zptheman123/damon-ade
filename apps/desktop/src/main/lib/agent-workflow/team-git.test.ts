import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commitFiles, handoffFiles, integrateCommit } from "./team-git";

/**
 * Agent-to-agent handoffs in real temporary repositories: a main folder
 * and two agents' worktrees on their own branches, like a team's.
 */

const root = mkdtempSync(join(tmpdir(), "ade-handoff-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}

/** Text as written, whatever line endings the checkout used. */
const text = (path: string) =>
	readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function write(dir: string, path: string, content: string) {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), content);
}

/** A repository with a UI agent's and a Frontend agent's worktrees. */
function team(name: string) {
	const main = join(root, name, "main");
	mkdirSync(main, { recursive: true });
	git(main, "init", "-q", "-b", "main");
	git(main, "config", "user.email", "t@example.com");
	git(main, "config", "user.name", "T");
	write(main, "package.json", "{}\n");
	write(main, ".gitignore", "node_modules/\n");
	git(main, "add", "-A");
	git(main, "commit", "-qm", "scaffold");
	const ui = join(root, name, "ui");
	const frontend = join(root, name, "frontend");
	git(main, "worktree", "add", "-q", "-b", "ade/ui", ui);
	git(main, "worktree", "add", "-q", "-b", "ade/frontend", frontend);
	const backups = join(root, name, "backups");
	return { main, ui, frontend, backups };
}

/** The UI agent finishes: ADE commits its own files (as a handoff). */
function uiFinishes(ui: string, files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) write(ui, path, content);
	const { files: handed } = handoffFiles(Object.keys(files));
	const result = commitFiles(ui, handed, "Fix shell accessibility");
	if ("error" in result) throw new Error(result.error);
	return result.commit;
}

describe("handoffs between agents", () => {
	it("leave build output and private files out of the commit", () => {
		expect(
			handoffFiles([
				"src/App.tsx",
				"tsconfig.web.tsbuildinfo",
				"out/main/index.js",
				"node_modules/x/index.js",
				".env",
				".env.local",
				".env.example",
				"certs/dev.pem",
				"debug.log",
			]),
		).toEqual({
			files: ["src/App.tsx", ".env.example"],
			skipped: [
				{ path: "tsconfig.web.tsbuildinfo", why: "generated" },
				{ path: "out/main/index.js", why: "generated" },
				{ path: "node_modules/x/index.js", why: "generated" },
				{ path: ".env", why: "private" },
				{ path: ".env.local", why: "private" },
				{ path: "certs/dev.pem", why: "private" },
				{ path: "debug.log", why: "generated" },
			],
		});
	});

	it("a normal handoff merges the work, and repeating it changes nothing", () => {
		const t = team("normal");
		const commit = uiFinishes(t.ui, {
			"src/AppShell.tsx": "export const shell = 1;\n",
		});
		const first = integrateCommit(t.frontend, commit, "Bring in UI", t.backups);
		expect(first.status).toBe("merged");
		expect(text(join(t.frontend, "src/AppShell.tsx"))).toBe(
			"export const shell = 1;\n",
		);
		const head = git(t.frontend, "rev-parse", "HEAD");
		const again = integrateCommit(t.frontend, commit, "Bring in UI", t.backups);
		expect(again.status).toBe("already-in");
		expect(git(t.frontend, "rev-parse", "HEAD")).toBe(head);
	});

	it("the calendar collision: an untracked build cache and an identical file are moved aside, never deleted", () => {
		const t = team("collision");
		// What the old handoff did: the UI agent's build cache got committed.
		write(t.ui, "src/tokens.css", ":root { --accent: #2563eb; }\n");
		write(t.ui, "tsconfig.web.tsbuildinfo", '{"version":"ui"}');
		git(t.ui, "add", "-A");
		git(t.ui, "commit", "-qm", "Fix shell accessibility (old handoff)");
		const commit = git(t.ui, "rev-parse", "HEAD");
		// The Frontend folder has its own cache and the same tokens file, uncommitted.
		write(t.frontend, "tsconfig.web.tsbuildinfo", '{"version":"frontend"}');
		write(t.frontend, "src/tokens.css", ":root { --accent: #2563eb; }\n");
		// Plain git refuses here (the recorded error).
		const plain = spawnSync("git", ["merge", "--no-edit", commit], {
			cwd: t.frontend,
			encoding: "utf8",
		});
		expect(plain.status).not.toBe(0);
		expect(`${plain.stderr}${plain.stdout}`).toContain(
			"untracked working tree files would be overwritten",
		);

		const result = integrateCommit(
			t.frontend,
			commit,
			"Bring in UI",
			t.backups,
		);
		expect(result.status).toBe("merged");
		if (result.status !== "merged") return;
		expect(result.movedAside.map((m) => [m.path, m.why]).sort()).toEqual([
			["src/tokens.css", "identical"],
			["tsconfig.web.tsbuildinfo", "generated"],
		]);
		// The Frontend's own copies are kept, outside the repository.
		const cache = result.movedAside.find((m) => m.why === "generated");
		expect(text(cache?.backup ?? "")).toBe('{"version":"frontend"}');
		expect(cache?.backup.startsWith(t.backups)).toBe(true);
		expect(git(t.frontend, "status", "--porcelain")).toBe("");
	});

	it("an untracked file with different contents is not touched: ADE names it and waits", () => {
		const t = team("different");
		const commit = uiFinishes(t.ui, {
			"src/theme.ts": "export const theme = 'ui';\n",
		});
		write(
			t.frontend,
			"src/theme.ts",
			"export const theme = 'frontend work';\n",
		);
		const head = git(t.frontend, "rev-parse", "HEAD");
		const result = integrateCommit(
			t.frontend,
			commit,
			"Bring in UI",
			t.backups,
		);
		expect(result.status).toBe("needs-decision");
		if (result.status !== "needs-decision") return;
		expect(result.paths).toEqual(["src/theme.ts"]);
		expect(result.explanation).toContain("src/theme.ts");
		expect(result.explanation).toContain("has not changed them");
		expect(text(join(t.frontend, "src/theme.ts"))).toBe(
			"export const theme = 'frontend work';\n",
		);
		expect(git(t.frontend, "rev-parse", "HEAD")).toBe(head);
		expect(existsSync(t.backups)).toBe(false);
	});

	it("a real conflict is undone and named; files moved aside come back", () => {
		const t = team("conflict");
		const commit = uiFinishes(t.ui, {
			"package.json": '{"name":"ui"}\n',
			"src/theme.css": "a {}\n",
		});
		write(t.frontend, "package.json", '{"name":"frontend"}\n');
		git(t.frontend, "commit", "-qam", "frontend package name");
		write(t.frontend, "src/theme.css", "a {}\n"); // identical, untracked
		const head = git(t.frontend, "rev-parse", "HEAD");
		const result = integrateCommit(
			t.frontend,
			commit,
			"Bring in UI",
			t.backups,
		);
		expect(result.status).toBe("conflict");
		if (result.status !== "conflict") return;
		expect(result.paths).toEqual(["package.json"]);
		expect(git(t.frontend, "rev-parse", "HEAD")).toBe(head);
		expect(existsSync(join(t.frontend, ".git"))).toBe(true);
		expect(git(t.frontend, "status", "--porcelain", "-uall")).toBe(
			"?? src/theme.css",
		);
		expect(text(join(t.frontend, "src/theme.css"))).toBe("a {}\n");
	});
});
