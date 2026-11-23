import { afterAll, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectKey, trustFolderForClaude } from "./claude-trust";

/** Always a temporary ~/.claude.json: the user's real file is never touched. */
const root = mkdtempSync(join(tmpdir(), "ade-trust-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function config(content: object) {
	const path = join(root, `claude-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(path, JSON.stringify(content, null, 2));
	return path;
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("trusting ADE's task folder for Claude Code", () => {
	it("uses Claude Code's key form: forward slashes, upper-case drive", () => {
		expect(
			claudeProjectKey(
				"c:\\Users\\Zain\\.ade\\workflow\\projects\\app\\tasks\\",
			),
		).toBe("C:/Users/Zain/.ade/workflow/projects/app/tasks");
	});

	it("records trust for the folder and changes nothing else", () => {
		const tasks = join(root, "workflow", "projects", "app", "tasks");
		mkdirSync(tasks, { recursive: true });
		const path = config({
			numStartups: 7,
			oauthAccount: { emailAddress: "x" },
			projects: {
				"D:/Claude Projects/Test App": {
					hasTrustDialogAccepted: true,
					allowedTools: ["Read"],
				},
			},
		});
		expect(trustFolderForClaude(tasks, path)).toBe("trusted");
		const after = read(path);
		expect(after.projects[claudeProjectKey(tasks)]).toEqual({
			hasTrustDialogAccepted: true,
		});
		expect(after.numStartups).toBe(7);
		expect(after.oauthAccount).toEqual({ emailAddress: "x" });
		expect(after.projects["D:/Claude Projects/Test App"]).toEqual({
			hasTrustDialogAccepted: true,
			allowedTools: ["Read"],
		});
		// Again: nothing to do.
		expect(trustFolderForClaude(tasks, path)).toBe("already");
	});

	it("keeps an existing entry's other settings", () => {
		const tasks = join(root, "tasks-existing");
		mkdirSync(tasks, { recursive: true });
		const path = config({
			projects: { [claudeProjectKey(tasks)]: { allowedTools: ["Bash(ls)"] } },
		});
		expect(trustFolderForClaude(tasks, path)).toBe("trusted");
		expect(read(path).projects[claudeProjectKey(tasks)]).toEqual({
			allowedTools: ["Bash(ls)"],
			hasTrustDialogAccepted: true,
		});
	});

	it("never trusts a folder with a .claude directory, never rewrites an unreadable file, never creates the file", () => {
		const withClaude = join(root, "tasks-with-claude");
		mkdirSync(join(withClaude, ".claude"), { recursive: true });
		const path = config({ projects: {} });
		expect(trustFolderForClaude(withClaude, path)).toBe("skipped");
		expect(read(path).projects).toEqual({});

		const plain = join(root, "tasks-plain");
		mkdirSync(plain, { recursive: true });
		const broken = join(root, "broken.json");
		writeFileSync(broken, "{ not json");
		expect(trustFolderForClaude(plain, broken)).toBe("skipped");
		expect(readFileSync(broken, "utf8")).toBe("{ not json");
		expect(trustFolderForClaude(plain, join(root, "missing.json"))).toBe(
			"skipped",
		);
	});
});
