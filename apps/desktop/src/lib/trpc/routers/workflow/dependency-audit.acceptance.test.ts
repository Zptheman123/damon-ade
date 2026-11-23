import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditCommandResult } from "main/lib/agent-workflow/dependency-audit";

/**
 * Auto's dependency audit through the Tasks router and the real
 * TaskController: ADE runs the package manager itself between the
 * implementation and the review. The model and the package manager are
 * fakes; nothing is installed or fetched.
 */

const TEST_HOME = mkdtempSync(join(tmpdir(), "ade-audit-home-"));
process.env.ADE_HOME_DIR = TEST_HOME;
const bashPath = Bun.which("bash");
const bash = bashPath && !/System32/i.test(bashPath) ? bashPath : null;
const git = Bun.which("git");

let root: string;
let fake: import("main/lib/agent-workflow/testing/fake-claude").FakeClaude;
let restoreNetwork: () => void;
let controller: import("main/lib/agent-workflow/controller").TaskController;
let settings: typeof import("main/lib/agent-workflow/workflow-settings");
let tasks: ReturnType<
	ReturnType<typeof import("./workflow").createWorkflowRouter>["createCaller"]
>;
const workspaces = new Map<string, { root: string; worktree: string }>();

/** The fake package manager: each test sets how it answers. */
let answer: (command: string, cwd: string) => string = () => "";
const managerCalls: string[] = [];

const npmReport = (
	vulns: Record<string, { severity: string; fixAvailable?: boolean }>,
) =>
	JSON.stringify({
		vulnerabilities: Object.fromEntries(
			Object.entries(vulns).map(([name, v]) => [
				name,
				{
					name,
					severity: v.severity,
					via: [
						{
							title: `${name} advisory`,
							url: `https://github.com/advisories/${name}`,
						},
					],
					fixAvailable: v.fixAvailable ?? false,
				},
			]),
		),
		metadata: { vulnerabilities: {} },
	});

const PKG = `${JSON.stringify({ name: "cal", overrides: { "glob-parent": "^6.0.2" } }, null, 2)}\n`;

function sh(cwd: string, ...args: string[]) {
	const r = spawnSync(git as string, args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
}

function makeRepo(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), PKG);
	writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
	writeFileSync(join(dir, "README.md"), "# Calendar\n");
	sh(dir, "init", "-q");
	sh(dir, "config", "user.email", "t@example.com");
	sh(dir, "config", "user.name", "T");
	sh(dir, "add", "-A");
	sh(dir, "commit", "-qm", "init");
	return dir;
}

async function view(workspaceId: string, slug: string) {
	const task = (await tasks.getProjectTasks({ workspaceId })).tasks.find(
		(t) => t.slug === slug,
	);
	if (!task) throw new Error(`no task ${slug}`);
	return task;
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ade-audit-"));
	const project = await import("main/lib/agent-workflow/project-workflow");
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
		runChecks: ({ cwd, commands, signal }) =>
			checks.runChecks({
				cwd,
				commands,
				signal,
				shell: [bash as string, "-c"],
				spawnFn,
				killTree,
			}),
		runAudit: async ({ command, cwd }): Promise<AuditCommandResult> => {
			managerCalls.push(command);
			const stdout = answer(command, cwd);
			return {
				exitCode: stdout.includes('"severity"') ? 1 : 0,
				stdout,
				stderr: "",
			};
		},
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
					project: project.ensureProjectWorkflow(TEST_HOME, ws.root),
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

const addDependency = {
	"package.json": PKG.replace(
		'"name": "cal",',
		'"name": "cal",\n  "dependencies": { "date-fns": "^4.1.0" },',
	),
	"package-lock.json": '{"lockfileVersion":3,"packages":{"date-fns":{}}}\n',
	"{task}/progress.md": "Status: implemented\n",
};

describe.if(bash !== null && git !== null)("Auto's dependency audit", () => {
	it("runs after a dependency change with no model run of its own; dev-only advisories become review notes", async () => {
		const repo = makeRepo("notes");
		workspaces.set("ws-notes", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-notes", commands: [] });
		answer = (command) =>
			command.includes("--omit=dev")
				? npmReport({})
				: npmReport({
						esbuild: { severity: "moderate" },
						vite: { severity: "high" },
					});
		managerCalls.length = 0;
		fake.setSteps([
			{ name: "implement", write: addDependency, cost: 0.2 },
			{ name: "review", text: "VERDICT: PASS", cost: 0.1 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-notes",
			description: "Add date-fns for the calendar's date maths",
			route: "implement",
			research: "none",
		});
		await controller.idle();
		const task = await view("ws-notes", created.slug);
		expect(task.state).toBe("done");
		expect(task.runs.map((r) => r.kind)).toEqual([
			"implement",
			"deps",
			"review",
		]);
		// Only the two model runs the task needed anyway.
		const calls = fake.calls().slice(before);
		expect(calls.map((c) => c.step)).toEqual(["implement", "review"]);
		expect(task.runs[1].audit?.state).toBe("warnings");
		expect(managerCalls).toEqual([
			"npm audit --json",
			"npm audit --json --omit=dev",
		]);
		// The review is told, as notes.
		expect(calls[1].stdin).toContain("## Dependency audit (run by ADE)");
		expect(calls[1].stdin).toContain("vite (high, development only)");
	}, 60_000);

	it("applies the package manager's safe fix, keeps overrides, and the checks run on the fixed tree", async () => {
		const repo = makeRepo("fix");
		workspaces.set("ws-fix", { root: repo, worktree: repo });
		await tasks.setChecks({
			workspaceId: "ws-fix",
			commands: ["git diff --quiet HEAD -- README.md"],
		});
		let fixed = false;
		answer = (command, cwd) => {
			if (command === "npm audit fix --ignore-scripts") {
				fixed = true;
				writeFileSync(
					join(cwd, "package-lock.json"),
					'{"lockfileVersion":3,"fixed":true}\n',
				);
				return "";
			}
			return fixed
				? npmReport({})
				: npmReport({ vite: { severity: "moderate", fixAvailable: true } });
		};
		managerCalls.length = 0;
		fake.setSteps([
			{ name: "implement", write: addDependency, cost: 0.2 },
			{ name: "review", text: "VERDICT: PASS", cost: 0.1 },
		]);
		const created = await tasks.createTask({
			workspaceId: "ws-fix",
			description: "Add date-fns",
			route: "implement",
			research: "none",
		});
		await controller.idle();
		const task = await view("ws-fix", created.slug);
		expect(task.state).toBe("done");
		expect(task.runs.map((r) => r.kind)).toEqual([
			"implement",
			"deps",
			"checks",
			"review",
		]);
		expect(task.runs[1].audit?.fixed).toEqual(["vite"]);
		expect(managerCalls).toContain("npm audit fix --ignore-scripts");
		expect(managerCalls.some((c) => c.includes("--force"))).toBe(false);
	}, 60_000);

	it("high or critical production advisories get one correction run, then pass", async () => {
		const repo = makeRepo("critical");
		workspaces.set("ws-crit", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-crit", commands: [] });
		let upgraded = false;
		answer = () =>
			upgraded
				? npmReport({})
				: npmReport({ "left-pad": { severity: "critical" } });
		fake.setSteps([
			{ name: "implement", write: addDependency, cost: 0.2 },
			{
				name: "fix",
				write: {
					"package-lock.json":
						'{"lockfileVersion":3,"packages":{"left-pad":"2"}}\n',
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.1,
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.1 },
		]);
		const before = fake.calls().length;
		const created = await tasks.createTask({
			workspaceId: "ws-crit",
			description: "Add left-pad",
			route: "implement",
			research: "none",
		});
		// The fake "upgrades" once the correction run has started.
		const timer = setInterval(() => {
			if (fake.calls().some((c, i) => i >= before && c.step === "fix"))
				upgraded = true;
		}, 20);
		await controller.idle();
		clearInterval(timer);
		const task = await view("ws-crit", created.slug);
		expect(task.state).toBe("done");
		expect(task.runs.map((r) => r.kind)).toEqual([
			"implement",
			"deps",
			"fix",
			"deps",
			"review",
		]);
		const calls = fake.calls().slice(before);
		expect(calls.map((c) => c.step)).toEqual(["implement", "fix", "review"]);
		expect(calls[1].stdin).toContain("left-pad (critical)");
		expect(calls[1].stdin).toContain("Keep the project's existing overrides");
	}, 60_000);

	it("skips the audit when dependencies did not change, and when the policy is off", async () => {
		const repo = makeRepo("plain");
		workspaces.set("ws-plain", { root: repo, worktree: repo });
		await tasks.setChecks({ workspaceId: "ws-plain", commands: [] });
		managerCalls.length = 0;
		fake.setSteps([
			{
				name: "quick",
				write: {
					"README.md": "# Calendar app\n",
					"{task}/progress.md": "Status: implemented\n",
				},
				cost: 0.02,
			},
			{ name: "review", text: "VERDICT: PASS", cost: 0.01 },
		]);
		const docs = await tasks.createTask({
			workspaceId: "ws-plain",
			description: "Fix the README title",
			route: "quick",
			research: "none",
		});
		await controller.idle();
		expect((await view("ws-plain", docs.slug)).runs.map((r) => r.kind)).toEqual(
			["quick", "review"],
		);

		const off = settings.defaultWorkflowSettings();
		off.execution.dependencyAudit = "off";
		settings.saveWorkflowSettings(TEST_HOME, off);
		fake.setSteps([
			{ name: "implement", write: addDependency, cost: 0.2 },
			{ name: "review", text: "VERDICT: PASS", cost: 0.1 },
		]);
		const dep = await tasks.createTask({
			workspaceId: "ws-plain",
			description: "Add date-fns",
			route: "implement",
			research: "none",
		});
		await controller.idle();
		expect((await view("ws-plain", dep.slug)).runs.map((r) => r.kind)).toEqual([
			"implement",
			"review",
		]);
		expect(managerCalls).toEqual([]);
		settings.saveWorkflowSettings(
			TEST_HOME,
			settings.defaultWorkflowSettings(),
		);
	}, 60_000);
});
