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
let settings: typeof import("main/lib/agent-workflow/workflow-settings");
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
	settings = await import("main/lib/agent-workflow/workflow-settings");
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
		runChecks: ({ cwd, commands, signal, continuePast }) =>
			checks.runChecks({
				cwd,
				commands,
				signal,
				continuePast,
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

	it("a check that already failed before the task starts no fix; the review sees it", async () => {
		const repo = makeRepo("baseline");
		// The project's lint fails before anyone changes anything (as CRLF
		// checkouts made Prettier fail on every file).
		writeFileSync(join(repo, "legacy.txt"), "unformatted\n");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-qm", "legacy");
		workspaces.set("ws-base", { root: repo, worktree: repo });
		const lint = "echo 'legacy.txt: Delete CR'; test ! -f legacy.txt";
		const test = "test -f src/month.js";
		await tasks.setChecks({ workspaceId: "ws-base", commands: [lint, test] });
		fake.setSteps([
			{
				name: "implement",
				write: {
					"src/month.js": "export const month = 1;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.05,
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.02 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-base",
			description: "Add the month view",
			route: "implement",
			research: "none",
		});
		await controller.idle();
		const task = await view("ws-base", created.slug);
		expect(task.state).toBe("done");
		// No fix run: just the implementation and the review.
		const calls = fake.calls().slice(before);
		expect(calls.map((c) => c.step)).toEqual(["implement", "review"]);
		const review = calls.find((c) => c.step === "review");
		expect(review?.stdin).toContain(
			"Checks that already failed before this task",
		);
		expect(review?.stdin).toContain("(still fails)");
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

	it("a team request keeps going: a subtask whose reviews keep failing is accepted and its findings go to QA", async () => {
		const repo = makeRepo("keep-going");
		workspaces.set("ws-go", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-go", commands: [] });
		const finding = "The mini calendar has 42 tab stops; add a skip link.";
		const fail = {
			name: "shell-review",
			text: `VERDICT: FAIL\n${finding}`,
			cost: 0.02,
		};
		const fix = {
			name: "shell-fix",
			write: {
				"src/shell.js": "export const shell = 2;\n",
				"{task}/progress.md": "Status: implemented\n",
			},
			cost: 0.02,
		};
		fake.setSteps([
			{
				name: "split",
				text: '```json\n{"subtasks": [{"title": "Design system and app shell", "description": "Build the shell.", "route": "quick"}, {"title": "QA and polish pass", "description": "Exercise every flow.", "route": "quick"}], "reason": "shell first"}\n```',
				cost: 0.02,
			},
			{
				name: "shell",
				write: {
					"src/shell.js": "export const shell = 1;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.02,
			},
			fail,
			fix,
			fail,
			fix,
			fail,
			{
				name: "qa",
				write: {
					"src/qa.js": "export const qa = 1;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.02,
			},
			{ name: "qa-review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-go",
			description: "Build a desktop calendar app",
			split: true,
		});
		await controller.idle();
		const all = (await tasks.getProjectTasks({ workspaceId: "ws-go" })).tasks;
		const request = all.find((t) => t.slug === created.slug);
		const shell = all.find((t) => t.title === "Design system and app shell");
		const qa = all.find((t) => t.title === "QA and polish pass");
		// Never paused: the whole request finished.
		expect(request?.state).toBe("done");
		expect(shell?.state).toBe("done");
		expect(shell?.accepted?.stoppedBy).toContain("correction(s)");
		expect(shell?.stateReason).toContain('added to "QA and polish pass"');
		expect(qa?.state).toBe("done");
		expect(qa?.notes[0]?.text).toContain(finding);
		// QA's run was told the findings.
		const qaCall = fake
			.calls()
			.slice(before)
			.find((c) => c.step === "qa");
		expect(qaCall?.stdin).toContain(finding);
		expect(fake.remainingSteps()).toBe(0);
	}, 120_000);

	it("with keep-going off, the request pauses as before", async () => {
		const off = settings.defaultWorkflowSettings();
		off.execution.keepGoing = false;
		settings.saveWorkflowSettings(TEST_HOME, off);
		try {
			const repo = makeRepo("stop");
			workspaces.set("ws-stop", { root: repo, worktree: repo });
			await tasks.setChecks({ workspaceId: "ws-stop", commands: [] });
			const fail = {
				name: "review",
				text: "VERDICT: FAIL\nStill wrong.",
				cost: 0.02,
			};
			const fix = {
				name: "fix",
				write: {
					"src/a.js": "export const a = 2;\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.02,
			};
			fake.setSteps([
				{
					name: "split",
					text: '```json\n{"subtasks": [{"title": "Part A", "description": "A.", "route": "quick"}, {"title": "QA", "description": "Check.", "route": "quick"}], "reason": "A first"}\n```',
					cost: 0.02,
				},
				{
					name: "a",
					write: {
						"src/a.js": "export const a = 1;\n",
						"{task}/progress.md": "Status: implemented\n",
					},
					cost: 0.02,
				},
				fail,
				fix,
				fail,
				fix,
				fail,
			]);
			const created = await tasks.createTask({
				workspaceId: "ws-stop",
				description: "Build part A and check it",
				split: true,
			});
			await controller.idle();
			const all = (await tasks.getProjectTasks({ workspaceId: "ws-stop" }))
				.tasks;
			expect(all.find((t) => t.slug === created.slug)?.state).toBe("paused");
			expect(all.find((t) => t.title === "Part A")?.state).toBe("blocked");
			expect(all.find((t) => t.title === "QA")?.state).toBe("idle");
		} finally {
			settings.saveWorkflowSettings(
				TEST_HOME,
				settings.defaultWorkflowSettings(),
			);
		}
	}, 120_000);

	it("Resume all continues what can continue and says what still needs a decision", async () => {
		const repo = makeRepo("resume-all");
		workspaces.set("ws-all", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-all", commands: [] });
		// Two tasks the user paused, one waiting for a plan answer.
		const make = (description: string) =>
			tasks.createTask({
				workspaceId: "ws-all",
				description,
				route: "quick",
				mode: "manual",
				research: "none",
			});
		const a = await make("Fix the header colour");
		const b = await make("Fix the footer colour");
		for (const slug of [a.slug, b.slug]) {
			await tasks.setMode({ workspaceId: "ws-all", slug, mode: "auto" });
			await tasks.pause({ workspaceId: "ws-all", slug });
		}
		const asking = await make("Rework navigation");
		const { project } = await tasks.getProjectTasks({ workspaceId: "ws-all" });
		const planDir = join(
			TEST_HOME,
			"workflow",
			"projects",
			project.key,
			"tasks",
			asking.slug,
		);
		writeFileSync(
			join(planDir, "plan.md"),
			"# Plan\n## Questions for the user\n- Tabs or a sidebar?\n",
		);
		await tasks.setMode({
			workspaceId: "ws-all",
			slug: asking.slug,
			mode: "auto",
		});
		await tasks.pause({ workspaceId: "ws-all", slug: asking.slug });
		const record = (await import("main/lib/agent-workflow/tasks")).getTask(
			(
				await import("main/lib/agent-workflow/project-workflow")
			).ensureProjectWorkflow(TEST_HOME, repo),
			asking.slug,
		);
		if (record) {
			record.state = "needs-input";
			(await import("main/lib/agent-workflow/tasks")).saveTask(
				(
					await import("main/lib/agent-workflow/project-workflow")
				).ensureProjectWorkflow(TEST_HOME, repo),
				record,
			);
		}
		expect((await tasks.attention({ workspaceId: "ws-all" })).length).toBe(3);

		const step = (name: string) => ({
			name,
			write: {
				"README.md": `# ${name}\n`,
				"{task}/progress.md": "Status: implemented\n",
			},
			cost: 0.01,
		});
		fake.setSteps([
			step("header"),
			{ name: "review-1", text: "VERDICT: PASS", cost: 0.01 },
			step("footer"),
			{ name: "review-2", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const result = await tasks.resumeAll({ workspaceId: "ws-all" });
		await controller.idle();
		expect(result.resumed).toBe(2);
		expect(result.still.map((s) => [s.title, s.reason])).toEqual([
			["Rework navigation", "The plan has questions for you."],
		]);
		const left = await tasks.attention({ workspaceId: "ws-all" });
		expect(left.map((t) => t.title)).toEqual(["Rework navigation"]);

		// The workspace's activity: nothing running, one waiting, two done.
		const activity = await tasks.agentActivity({ workspaceId: "ws-all" });
		expect(activity.current).toBeNull();
		expect(activity.waiting.map((w) => w.title)).toEqual(["Rework navigation"]);
		expect(activity.recent.map((r) => [r.title, r.state]).sort()).toEqual([
			["Fix the footer colour", "done"],
			["Fix the header colour", "done"],
		]);
		expect(activity.recent.every((r) => r.costUsd > 0)).toBe(true);
	}, 120_000);
});
