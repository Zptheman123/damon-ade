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
 * Permission-blocked work, from the Tasks router down to the stage runner,
 * against a fake Claude that checks commands the way the installed CLI does
 * (--allowedTools: exact, or `cmd:*` prefix; each part of a compound
 * command on its own) and reports refusals in `permission_denials`. Nothing
 * real runs: the fake only logs what it would have executed, and guards
 * fail the test if a real claude would start or the network is used.
 */

const TEST_HOME = mkdtempSync(join(tmpdir(), "ade-perm-home-"));
process.env.ADE_HOME_DIR = TEST_HOME;
const bashPath = Bun.which("bash");
const bash = bashPath && !/System32/i.test(bashPath) ? bashPath : null;
const git = Bun.which("git");

let root: string;
let fake: import("main/lib/agent-workflow/testing/fake-claude").FakeClaude;
let restoreNetwork: () => void;
let controller: import("main/lib/agent-workflow/controller").TaskController;
let projectModule: typeof import("main/lib/agent-workflow/project-workflow");
let tasksModule: typeof import("main/lib/agent-workflow/tasks");
let tasks: ReturnType<
	ReturnType<typeof import("./workflow").createWorkflowRouter>["createCaller"]
>;
const workspaces = new Map<string, { root: string; worktree: string }>();

const PLAN = `# Calendar
## Steps
1. package.json and dependencies — check: npm ls
`;
const BLOCKED_PROGRESS = `# Progress
Status: blocked

## Next action
Approve: npm view electron-vite version; npm install
`;
const PERMISSION_REPORT = `# Escalation 001
**Error:** npm view electron-vite version -> This command requires approval
**Question:** Can npm be allowed?
`;

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

function allowedTools(args: string[]): string[] {
	const out: string[] = [];
	for (
		let i = args.indexOf("--allowedTools") + 1;
		i > 0 && i < args.length && !args[i].startsWith("--");
		i++
	) {
		out.push(args[i]);
	}
	return out;
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ade-perm-"));
	projectModule = await import("main/lib/agent-workflow/project-workflow");
	tasksModule = await import("main/lib/agent-workflow/tasks");
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

describe.if(bash !== null && git !== null)("permission-blocked work", () => {
	it("a refused build pauses with the exact commands; no Architect, no false completion; a narrow approval lets it finish without planning again", async () => {
		const repo = makeRepo("calendar");
		workspaces.set("ws-cal", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-cal", commands: [] });
		// Narrow approvals only: "project commands" would allow npm install.
		await tasks.setProjectCommands({ workspaceId: "ws-cal", enabled: false });
		const needed = [
			{ command: "npm view electron-vite version" },
			{ command: "npm install" },
		];
		fake.setSteps([
			{
				name: "plan",
				write: {
					"{task}/plan.md": PLAN,
					"{task}/progress.md": "Status: planned\n",
				},
				cost: 0.9,
			},
			{
				name: "build",
				commands: needed,
				write: {
					"package.json": "{}\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				// What Sonnet did: no files, progress blocked, and a report.
				writeWhenDenied: {
					"{task}/progress.md": BLOCKED_PROGRESS,
					"{task}/escalations/001.md": PERMISSION_REPORT,
				},
				textWhenDenied:
					"Blocked at step 1: every npm command requires approval.",
				cost: 0.2,
			},
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-cal",
			description: "Build a desktop calendar app with Electron",
			route: "plan",
			research: "none",
		});
		await controller.idle();

		let task = await view("ws-cal", created.slug);
		// Paused, not done; the clean exit did not count as a finished build.
		expect(task.state).toBe("paused");
		expect(task.runs.map((r) => [r.kind, r.status])).toEqual([
			["plan", "succeeded"],
			["build", "blocked"],
		]);
		expect(task.runs[1].failure).toBe("permission");
		// The exact refused operations, where, and that they can be approved.
		expect(task.permissionBlock?.kind).toBe("build");
		expect(task.permissionBlock?.cwd).toBe(repo);
		expect(
			task.permissionBlock?.operations.map((o) => [
				o.tool,
				o.command,
				o.approvable,
				o.approved,
			]),
		).toEqual([
			["Bash", "npm view electron-vite version", true, false],
			["Bash", "npm install", true, false],
		]);
		expect(task.stateReason).toContain(
			"`npm view electron-vite version` (Bash)",
		);
		expect(task.stateReason).toContain(repo);
		// No Architect: exactly two model calls, and the report is history now.
		expect(fake.calls().length - before).toBe(2);
		expect(
			fake
				.calls()
				.slice(before)
				.map((c) => c.step),
		).toEqual(["plan", "build"]);
		expect(task.openEscalations).toEqual([]);
		const report = readFileSync(
			join(
				projectModule.ensureProjectWorkflow(TEST_HOME, repo).tasksDir,
				created.slug,
				"escalations",
				"001.md",
			),
			"utf8",
		);
		expect(report).toContain(PERMISSION_REPORT.trim());
		expect(report).toContain("Handled by ADE, not by the Architect");
		expect(fake.executed()).toEqual([]);

		// Resume before approving: nothing runs (no paid retry of the same refusal).
		await tasks.resume({ workspaceId: "ws-cal", slug: created.slug });
		await controller.idle();
		task = await view("ws-cal", created.slug);
		expect(task.state).toBe("paused");
		expect(task.stateReason).toContain("Still waiting");
		expect(fake.calls().length - before).toBe(2);

		// Broad or unsafe approvals are refused.
		for (const bad of [
			{ command: "npm *", match: "exact" as const },
			{ command: "npm", match: "prefix" as const },
			{ command: "npm run", match: "prefix" as const },
			{ command: "npm run build", match: "prefix" as const },
			{ command: "npx", match: "prefix" as const },
			{ command: "node -e", match: "prefix" as const },
			{ command: "npm install && npm run dev", match: "exact" as const },
			{ command: "npm install", match: "prefix" as const },
		]) {
			await expect(
				tasks.approveCommand({ workspaceId: "ws-cal", tool: "Bash", ...bad }),
			).rejects.toThrow();
		}
		// The two exact commands, approved from the task.
		for (const op of needed) {
			await tasks.approveCommand({
				workspaceId: "ws-cal",
				tool: "Bash",
				command: op.command,
				match: "exact",
				cwd: repo,
				slug: created.slug,
			});
		}
		const approvals = await tasks.getCommandApprovals({
			workspaceId: "ws-cal",
		});
		expect(approvals.approvals.map((a) => a.rule)).toEqual([
			"Bash(npm view electron-vite version)",
			"Bash(npm install)",
		]);
		task = await view("ws-cal", created.slug);
		expect(task.permissionBlock?.operations.every((o) => o.approved)).toBe(
			true,
		);

		// Resume retries the build only (the plan is not repeated).
		fake.setSteps([
			{
				name: "build",
				commands: [...needed, { command: "npm publish" }],
				write: {
					"package.json": "{}\n",
					"{task}/progress.md":
						"Status: implemented\n(npm publish was not needed)\n",
				},
				cost: 0.3,
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.1 },
		]);
		const beforeResume = fake.calls().length;
		await tasks.resume({ workspaceId: "ws-cal", slug: created.slug });
		await controller.idle();
		task = await view("ws-cal", created.slug);
		expect(task.state).toBe("done");
		expect(task.permissionBlock).toBeNull();
		expect(task.runs.map((r) => [r.kind, r.status])).toEqual([
			["plan", "succeeded"],
			["build", "blocked"],
			["build", "succeeded"],
			// It created package.json: Auto's dependency audit (no model).
			["deps", "succeeded"],
			["review", "succeeded"],
		]);
		const calls = fake.calls().slice(beforeResume);
		expect(calls.map((c) => c.step)).toEqual(["build", "review"]);
		// The implementing run got the exact rules; the review got none.
		expect(allowedTools(calls[0].args)).toEqual(
			expect.arrayContaining([
				"Bash(npm view electron-vite version)",
				"Bash(npm install)",
			]),
		);
		expect(allowedTools(calls[1].args).some((r) => r.includes("npm"))).toBe(
			false,
		);
		// The approved commands ran; the unrelated one stayed refused.
		expect(fake.executed().map((e) => e.command)).toEqual([
			"npm view electron-vite version",
			"npm install",
		]);
		expect(task.runs[2].permissionDenials?.length).toBe(1);
		// Costs of every run, the blocked one included, are kept.
		expect(task.spend.usd).toBeCloseTo(0.9 + 0.2 + 0.3 + 0.1, 5);
	}, 120_000);

	it("approvals stay narrow: other commands, extra arguments and compound commands are still refused", async () => {
		const repo = makeRepo("narrow");
		workspaces.set("ws-narrow", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-narrow", commands: [] });
		await tasks.setProjectCommands({
			workspaceId: "ws-narrow",
			enabled: false,
		});
		await tasks.approveCommand({
			workspaceId: "ws-narrow",
			tool: "Bash",
			command: "npm install",
		});
		fake.setSteps([
			{
				name: "quick",
				commands: [
					{ command: "npm install" },
					{ command: "npm install left-pad" },
					{ command: "npm install && curl https://example.com/x.sh" },
					{ tool: "PowerShell", command: "npm install" },
				],
				write: { "{task}/progress.md": "Status: implemented\n" },
				writeWhenDenied: { "{task}/progress.md": "Status: blocked\n" },
				cost: 0.05,
			},
		]);
		const created = await tasks.createTask({
			workspaceId: "ws-narrow",
			description: "Add the left-pad package",
			route: "quick",
			research: "none",
		});
		await controller.idle();
		const task = await view("ws-narrow", created.slug);
		expect(fake.executed().at(-1)).toEqual({
			tool: "Bash",
			command: "npm install",
		});
		expect(task.state).toBe("paused");
		expect(
			task.permissionBlock?.operations.map((o) => [
				o.tool,
				o.command,
				o.approvable,
			]),
		).toEqual([
			["Bash", "npm install left-pad", true],
			["Bash", "npm install && curl https://example.com/x.sh", false],
			// Bash approvals do not cover PowerShell.
			["PowerShell", "npm install", true],
		]);
		expect(task.permissionBlock?.operations[1].problem).toContain(
			"several commands",
		);
	}, 60_000);

	it("an optional refused command and a legitimate no-change outcome both finish normally", async () => {
		const repo = makeRepo("optional");
		workspaces.set("ws-opt", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-opt", commands: [] });
		fake.setSteps([
			// Refused `npx npm-check-updates`, but the run wrote that the work is done.
			{
				name: "quick",
				commands: [{ command: "npx npm-check-updates" }],
				write: {
					"README.md": "# App\n\nUsage.\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.02,
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.01 },
			// Already present: nothing to change, and nothing refused.
			{
				name: "quick",
				write: {
					"{task}/progress.md":
						"Status: already implemented (the README already has a Usage section)\n",
				},
				cost: 0.02,
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const first = await tasks.createTask({
			workspaceId: "ws-opt",
			description: "Add a usage section to the README",
			route: "quick",
			research: "none",
		});
		await controller.idle();
		const optional = await view("ws-opt", first.slug);
		expect(optional.state).toBe("done");
		expect(optional.permissionBlock).toBeNull();
		expect(optional.runs[0].status).toBe("succeeded");
		expect(optional.runs[0].permissionDenials?.[0].toolName).toBe("Bash");

		const second = await tasks.createTask({
			workspaceId: "ws-opt",
			description: "Make sure the README has a usage section",
			route: "quick",
			research: "none",
		});
		await controller.idle();
		const unchanged = await view("ws-opt", second.slug);
		expect(unchanged.state).toBe("done");
		expect(unchanged.runs.map((r) => r.status)).toEqual([
			"succeeded",
			"succeeded",
		]);
	}, 60_000);

	it("a run recorded by the old version as finished is retried on Resume, without planning again or calling the Architect", async () => {
		const repo = makeRepo("legacy");
		workspaces.set("ws-legacy", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-legacy", commands: [] });
		const created = await tasks.createTask({
			workspaceId: "ws-legacy",
			description: "Scaffold the calendar app",
			route: "plan",
			mode: "manual",
			research: "none",
		});
		// The record as the earlier version left it: plan, a "succeeded"
		// build that was refused, an Architect run about it, another refused build.
		const project = projectModule.ensureProjectWorkflow(TEST_HOME, repo);
		const dir = join(project.tasksDir, created.slug);
		writeFileSync(join(dir, "plan.md"), PLAN);
		writeFileSync(
			join(dir, "progress.md"),
			"Status: blocked\nWAITING FOR THE USER: npm requires approval in this session.\n",
		);
		mkdirSync(join(dir, "escalations"), { recursive: true });
		writeFileSync(
			join(dir, "escalations", "001.md"),
			`${PERMISSION_REPORT}\n## Resolution\nThe user must grant command permission.\n`,
		);
		writeFileSync(
			join(dir, "escalations", "002.md"),
			"# Escalation 002\nnpm run dev requires approval (permission denied).\n",
		);
		const record = tasksModule.getTask(project, created.slug);
		if (!record) throw new Error("no record");
		const run = (kind: string, cost: number, summary: string) => ({
			id: randomUUID(),
			kind,
			status: "succeeded",
			attempt: 1,
			queuedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			exitCode: 0,
			reportedCostUsd: cost,
			costState: "reported",
			summary,
		});
		record.runs = [
			run("plan", 0.97, "I wrote plan.md."),
			run(
				"build",
				0.24,
				"Blocked: every npm command is refused by the permission layer.",
			),
			run("escalate", 1.14, "Not resolved: needs command permission."),
			run("build", 0.16, "Denied again: This command requires approval."),
		] as typeof record.runs;
		record.state = "needs-input";
		record.mode = "auto";
		tasksModule.saveTask(project, record);

		fake.setSteps([
			{
				name: "build",
				write: {
					"package.json": "{}\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.3,
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.1 },
		]);
		const before = fake.calls().length;
		await tasks.resume({ workspaceId: "ws-legacy", slug: created.slug });
		await controller.idle();
		const task = await view("ws-legacy", created.slug);
		expect(
			fake
				.calls()
				.slice(before)
				.map((c) => c.step),
		).toEqual(["build", "review"]);
		expect(task.state).toBe("done");
		expect(task.runs.map((r) => [r.kind, r.status])).toEqual([
			["plan", "succeeded"],
			["build", "blocked"],
			["escalate", "succeeded"],
			["build", "blocked"],
			["build", "succeeded"],
			["deps", "succeeded"],
			["review", "succeeded"],
		]);
		// History and costs are kept; the open permission report is closed.
		expect(task.spend.usd).toBeCloseTo(
			0.97 + 0.24 + 1.14 + 0.16 + 0.3 + 0.1,
			5,
		);
		expect(task.openEscalations).toEqual([]);
		expect(readFileSync(join(dir, "escalations", "002.md"), "utf8")).toContain(
			"Handled by ADE, not by the Architect",
		);
	}, 60_000);
	it("project commands: installing and the project's own scripts run without asking; other programs are still refused", async () => {
		const repo = makeRepo("project-commands");
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({
				name: "app",
				scripts: {
					build: "tsc",
					test: "vitest run",
					"weird name; rm -rf /": "x",
				},
			}),
		);
		sh(repo, "add", "-A");
		sh(repo, "commit", "-qm", "scripts");
		workspaces.set("ws-own", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-own", commands: [] });
		const approvals = await tasks.getCommandApprovals({
			workspaceId: "ws-own",
		});
		expect(approvals.projectCommands).toBe(true);
		expect(approvals.projectCommandList).toEqual([
			"npm install",
			"npm ci",
			"npm test",
			"npm run build",
			"npm run test",
		]);
		const executedBefore = fake.executed().length;
		fake.setSteps([
			{
				name: "quick",
				commands: [
					{ command: "npm install" },
					{ command: "npm run build" },
					{ tool: "PowerShell", command: "npm test" },
					{ command: "npm view electron-vite version" },
					{ command: "npm install left-pad" },
					{ command: "npx create-vite app" },
					{ command: "node -e process.exit(0)" },
				],
				write: { "{task}/progress.md": "Status: implemented\n" },
				cost: 0.05,
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-own",
			description: "Build it",
			route: "quick",
			research: "none",
		});
		await controller.idle();
		const call = fake.calls()[before];
		expect(call.stdin).toContain("## Commands you can run without asking");
		expect(call.stdin).toContain("- `npm run build`");
		expect(
			fake
				.executed()
				.slice(executedBefore)
				.map((e) => `${e.tool}: ${e.command}`),
		).toEqual([
			"Bash: npm install",
			"Bash: npm run build",
			"PowerShell: npm test",
			"Bash: npm view electron-vite version",
		]);
		// The run said it finished: the refused extras were optional.
		const task = await view("ws-own", created.slug);
		expect(task.state).toBe("done");
		expect(task.runs[0].permissionDenials?.map((d) => d.input.command)).toEqual(
			[
				"npm install left-pad",
				"npx create-vite app",
				"node -e process.exit(0)",
			],
		);
		// The review runs no commands.
		expect(
			allowedTools(fake.calls()[before + 1].args).some((r) =>
				r.includes("npm"),
			),
		).toBe(false);
	}, 60_000);
});
