import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Accepting a stopped task as is, and notes for a task's later runs, from
 * the Tasks router down to the stage runner with a fake Claude (the same
 * harness as permissions.acceptance.test.ts). Guards fail the test if a
 * real claude would start or the network is used.
 */

const TEST_HOME = mkdtempSync(join(tmpdir(), "ade-accept-home-"));
process.env.ADE_HOME_DIR = TEST_HOME;
const bashPath = Bun.which("bash");
const bash = bashPath && !/System32/i.test(bashPath) ? bashPath : null;
const git = Bun.which("git");

let root: string;
let fake: import("main/lib/agent-workflow/testing/fake-claude").FakeClaude;
let restoreNetwork: () => void;
let controller: import("main/lib/agent-workflow/controller").TaskController;
let projectModule: typeof import("main/lib/agent-workflow/project-workflow");
let tasks: ReturnType<
	ReturnType<typeof import("./workflow").createWorkflowRouter>["createCaller"]
>;
const workspaces = new Map<string, { root: string; worktree: string }>();

function sh(cwd: string, ...args: string[]) {
	const r = spawnSync(git as string, args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

function makeRepo(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "README.md"), "# App\n");
	sh(dir, "init", "-q");
	sh(dir, "config", "user.email", "t@example.com");
	sh(dir, "config", "user.name", "T");
	sh(dir, "add", "-A");
	sh(dir, "commit", "-qm", "init");
	return dir;
}

async function view(workspaceId: string, slug: string) {
	const list = await tasks.getProjectTasks({ workspaceId });
	const task = list.tasks.find((t) => t.slug === slug);
	if (!task) throw new Error(`no task ${slug}`);
	return task;
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ade-accept-"));
	projectModule = await import("main/lib/agent-workflow/project-workflow");
	const controllerModule = await import("main/lib/agent-workflow/controller");
	const runner = await import("main/lib/agent-workflow/stage-runner");
	const checks = await import("main/lib/agent-workflow/checks");
	const identity = await import("main/lib/agent-workflow/identity");
	const settings = await import("main/lib/agent-workflow/workflow-settings");
	const fakeModule = await import(
		"main/lib/agent-workflow/testing/fake-claude"
	);
	const treeKill = await import("main/lib/tree-kill");
	const workflowRouter = await import("./workflow");

	settings.saveWorkflowSettings(TEST_HOME, settings.defaultWorkflowSettings());
	fake = fakeModule.createFakeClaude(root);
	restoreNetwork = fakeModule.blockNetwork();
	const spawnFn = fakeModule.guardedSpawn(fake, bash ? [bash] : []);
	const killTree = async (pid: number) => {
		await treeKill.treeKillWithEscalation({ pid, escalationTimeoutMs: 1000 });
	};
	controller = new controllerModule.TaskController({
		homeDir: TEST_HOME,
		loadSettings: () => settings.loadWorkflowSettings(TEST_HOME),
		resolveClaude: () => fake.command,
		startRun: (spec, onProgress) =>
			runner.startStageRun(spec, { spawnFn, killTree, onProgress }),
		runChecks: ({ cwd, commands, signal }) =>
			checks.runChecks({
				cwd,
				commands,
				signal,
				shell: [bash as string, "-c"],
				spawnFn,
				killTree,
			}),
		newId: randomUUID,
		now: () => new Date(),
		env: { ...process.env, ...fake.env },
		progressSaveIntervalMs: 0,
	});
	tasks = workflowRouter
		.createWorkflowRouter({
			homeDir: () => TEST_HOME,
			resolveWorkspace: (workspaceId: string) => {
				const ws = workspaces.get(workspaceId);
				if (!ws) throw new Error(`unknown workspace ${workspaceId}`);
				return {
					workspaceId,
					project: projectModule.ensureProjectWorkflow(TEST_HOME, ws.root),
					worktreePath: ws.worktree,
					runtime: "claude" as const,
				};
			},
			controller: () => controller,
			captureIdentity: identity.captureIdentity,
			listAgents: () => [],
			events: new EventEmitter(),
		})
		.createCaller({});
});

afterAll(async () => {
	await controller?.shutdown();
	restoreNetwork?.();
	rmSync(root, { recursive: true, force: true });
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe.if(bash !== null && git !== null)("accept as is, and notes", () => {
	it("a task stopped by a reviewer that keeps failing can be accepted as is; nothing runs again", async () => {
		const repo = makeRepo("accept");
		workspaces.set("ws-acc", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-acc", commands: [] });
		const fail = {
			name: "review",
			text: "VERDICT: FAIL\nThe skip link is missing.",
			cost: 0.05,
		};
		const fix = {
			name: "fix",
			write: {
				"README.md": "# App\n\nfixed\n",
				"{task}/progress.md": "Status: implemented\n",
			},
			cost: 0.05,
		};
		fake.setSteps([
			{
				name: "quick",
				write: {
					"README.md": "# App\n\nshell\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.05,
			},
			fail,
			fix,
			fail,
			fix,
			fail,
		]);
		const created = await tasks.createTask({
			workspaceId: "ws-acc",
			description: "Build the app shell",
			route: "quick",
			research: "none",
		});
		await controller.idle();
		let task = await view("ws-acc", created.slug);
		expect(task.state).toBe("blocked");
		expect(task.stateReason).toContain("after 2 correction(s)");
		expect(task.canAccept).toBe(true);

		// Resume alone would only stop again: nothing new runs.
		const before = fake.calls().length;
		await tasks.resume({ workspaceId: "ws-acc", slug: created.slug });
		await controller.idle();
		expect((await view("ws-acc", created.slug)).state).toBe("blocked");
		expect(fake.calls().length).toBe(before);

		await tasks.accept({ workspaceId: "ws-acc", slug: created.slug });
		await controller.idle();
		task = await view("ws-acc", created.slug);
		expect(task.state).toBe("done");
		expect(task.accepted?.stoppedBy).toContain("after 2 correction(s)");
		expect(task.stateReason).toContain("Accepted by you as is");
		expect(task.canAccept).toBe(false);
		expect(fake.calls().length).toBe(before);
	}, 90_000);

	it("only stopped tasks with implemented work can be accepted", async () => {
		const repo = makeRepo("accept-none");
		workspaces.set("ws-acc0", { root: repo, worktree: repo });
		const created = await tasks.createTask({
			workspaceId: "ws-acc0",
			description: "Not started yet",
			route: "quick",
			mode: "manual",
			research: "none",
		});
		await expect(
			tasks.accept({ workspaceId: "ws-acc0", slug: created.slug }),
		).rejects.toThrow();
		expect((await view("ws-acc0", created.slug)).canAccept).toBe(false);
	}, 30_000);

	it("notes added before a task starts reach its runs", async () => {
		const repo = makeRepo("notes");
		workspaces.set("ws-notes", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-notes", commands: [] });
		const created = await tasks.createTask({
			workspaceId: "ws-notes",
			description: "QA and polish pass",
			route: "quick",
			mode: "manual",
			research: "none",
		});
		await tasks.addNotes({
			workspaceId: "ws-notes",
			slug: created.slug,
			notes: "Add a skip link to #main.",
		});
		await tasks.addNotes({
			workspaceId: "ws-notes",
			slug: created.slug,
			notes: "Day buttons: names start with the visible number.",
		});
		const task = await view("ws-notes", created.slug);
		expect(task.notes.map((n) => n.text)).toEqual([
			"Add a skip link to #main.",
			"Day buttons: names start with the visible number.",
		]);
		const project = projectModule.ensureProjectWorkflow(TEST_HOME, repo);
		const md = readFileSync(
			join(project.tasksDir, created.slug, "task.md"),
			"utf8",
		);
		expect(md).toContain("## Notes from the user");
		expect(md.match(/## Notes from the user/g)?.length).toBe(1);
		expect(md).toContain("Add a skip link to #main.");
		fake.setSteps([
			{
				name: "quick",
				write: {
					"README.md": "# App\n\npolished\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.05,
			},
		]);
		await tasks.runStep({
			workspaceId: "ws-notes",
			slug: created.slug,
			kind: "quick",
		});
		await controller.idle();
		expect(fake.calls().at(-1)?.stdin).toContain(
			"Day buttons: names start with the visible number.",
		);
	}, 60_000);
});
