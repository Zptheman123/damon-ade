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
 * Handoffs between agents' folders through the real TaskController, in a
 * temporary repository with one worktree per agent (like a team's). The
 * model is a fake; guards fail the test if a real claude would start.
 */

const TEST_HOME = mkdtempSync(join(tmpdir(), "ade-handoff-home-"));
process.env.ADE_HOME_DIR = TEST_HOME;
const bashPath = Bun.which("bash");
const bash = bashPath && !/System32/i.test(bashPath) ? bashPath : null;
const git = Bun.which("git");

let root: string;
let fake: import("main/lib/agent-workflow/testing/fake-claude").FakeClaude;
let restoreNetwork: () => void;
let controller: import("main/lib/agent-workflow/controller").TaskController;
let tasks: ReturnType<
	ReturnType<typeof import("./workflow").createWorkflowRouter>["createCaller"]
>;
let specialists: ReturnType<
	ReturnType<
		typeof import("../specialists/specialists").createSpecialistsRouter
	>["createCaller"]
>;
const workspaces = new Map<string, { root: string; worktree: string }>();
const agentsByWorkspace = new Map<
	string,
	Array<{ workspaceId: string; name: string; worktreePath: string }>
>();

function sh(cwd: string, ...args: string[]) {
	const r = spawnSync(git as string, args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

const text = (path: string) =>
	readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** A repository and a worktree per agent, with specialists for them. */
async function team(name: string) {
	const repo = join(root, name);
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "README.md"), "# Calendar\n");
	writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
	sh(repo, "init", "-q");
	sh(repo, "config", "user.email", "t@example.com");
	sh(repo, "config", "user.name", "T");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-qm", "init");
	const ui = join(root, `${name}-ui`);
	const fe = join(root, `${name}-frontend`);
	sh(repo, "worktree", "add", "-q", "-b", "ade/ui", ui);
	sh(repo, "worktree", "add", "-q", "-b", "ade/frontend", fe);
	const ids = {
		lead: `${name}-lead`,
		ui: `${name}-ui`,
		fe: `${name}-fe`,
	};
	const agents = [
		{ workspaceId: ids.lead, name: "Lead", worktreePath: repo },
		{ workspaceId: ids.ui, name: "UI Agent", worktreePath: ui },
		{ workspaceId: ids.fe, name: "Frontend Agent", worktreePath: fe },
	];
	for (const agent of agents) {
		workspaces.set(agent.workspaceId, {
			root: repo,
			worktree: agent.worktreePath,
		});
		agentsByWorkspace.set(agent.workspaceId, agents);
	}
	await tasks.setChecks({ workspaceId: ids.lead, commands: [] });
	await specialists.save({
		workspaceId: ids.ui,
		specialist: { name: "UI", specialty: "Shell", agentWorkspaceId: ids.ui },
	});
	await specialists.save({
		workspaceId: ids.fe,
		specialist: {
			name: "Frontend",
			specialty: "Data and views",
			agentWorkspaceId: ids.fe,
		},
	});
	return { repo, ui, fe, ids };
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ade-handoff-acc-"));
	const project = await import("main/lib/agent-workflow/project-workflow");
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
	const specialistsRouter = await import("../specialists/specialists");

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
	const resolveWorkspace = (workspaceId: string) => {
		const ws = workspaces.get(workspaceId);
		if (!ws) throw new Error(`unknown workspace ${workspaceId}`);
		return {
			workspaceId,
			project: project.ensureProjectWorkflow(TEST_HOME, ws.root),
			worktreePath: ws.worktree,
			runtime: "claude" as const,
		};
	};
	tasks = workflowRouter
		.createWorkflowRouter({
			homeDir: () => TEST_HOME,
			resolveWorkspace,
			controller: () => controller,
			captureIdentity: identity.captureIdentity,
			listAgents: (id) => agentsByWorkspace.get(id) ?? [],
			events: new EventEmitter(),
		})
		.createCaller({});
	specialists = specialistsRouter
		.createSpecialistsRouter({
			resolveWorkspace,
			homeDir: () => TEST_HOME,
			listAgents: (id) => agentsByWorkspace.get(id) ?? [],
		})
		.createCaller({});
});

afterAll(async () => {
	await controller?.shutdown();
	restoreNetwork?.();
	rmSync(root, { recursive: true, force: true });
	rmSync(TEST_HOME, { recursive: true, force: true });
});

const done = { "{task}/progress.md": "Status: implemented\n" };

describe.if(bash !== null && git !== null)(
	"handoffs between agents' folders",
	() => {
		it("the calendar shape: finished work is checkpointed, build caches stay out of commits, and the next agent starts on both", async () => {
			const t = await team("calendar");
			// Each run also leaves TypeScript's build cache, as `tsc -b` does.
			fake.setSteps([
				{
					name: "split",
					text: '```json\n{"subtasks": [{"title": "Event data model", "description": "Store.", "specialist": "Frontend", "route": "quick", "dependsOn": []}, {"title": "Fix shell accessibility", "description": "Shell.", "specialist": "UI", "route": "quick", "dependsOn": [1]}, {"title": "Calendar views", "description": "Views.", "specialist": "Frontend", "route": "quick", "dependsOn": [1, 2]}], "reason": "data, shell, then views"}\n```',
					cost: 0.01,
				},
				{
					name: "data",
					write: {
						"src/store.js": "export const store = 1;\n",
						"tsconfig.web.tsbuildinfo": '{"by":"frontend"}',
						...done,
					},
					cost: 0.01,
				},
				{ name: "data-review", text: "VERDICT: PASS", cost: 0.01 },
				{
					name: "shell",
					write: {
						"src/shell.js": "export const shell = 1;\n",
						"tsconfig.web.tsbuildinfo": '{"by":"ui"}',
						".env.local": "SECRET=1\n",
						...done,
					},
					cost: 0.01,
				},
				{ name: "shell-review", text: "VERDICT: PASS", cost: 0.01 },
				{
					name: "views",
					write: { "src/views.js": "export const views = 1;\n", ...done },
					cost: 0.01,
				},
				{ name: "views-review", text: "VERDICT: PASS", cost: 0.01 },
			]);
			const created = await tasks.createTask({
				workspaceId: t.ids.lead,
				description: "Build the calendar",
				split: true,
			});
			await controller.idle();
			const all = (await tasks.getProjectTasks({ workspaceId: t.ids.lead }))
				.tasks;
			expect(all.find((x) => x.slug === created.slug)?.state).toBe("done");
			expect(fake.remainingSteps()).toBe(0);

			// The views run started in the Frontend folder with both agents' work.
			const views = fake.calls().find((c) => c.step === "views");
			expect(views?.cwd.replace(/\\/g, "/").toLowerCase()).toBe(
				t.fe.replace(/\\/g, "/").toLowerCase(),
			);
			const tracked = sh(t.fe, "ls-files");
			expect(tracked).toContain("src/store.js");
			expect(tracked).toContain("src/shell.js");
			// Build caches and private files were never committed anywhere.
			const everything = sh(t.repo, "log", "--all", "--name-only", "--format=");
			expect(everything).not.toContain("tsbuildinfo");
			expect(everything).not.toContain(".env.local");
			// Each folder keeps its own cache and private files, untouched.
			expect(text(join(t.fe, "tsconfig.web.tsbuildinfo"))).toBe(
				'{"by":"frontend"}',
			);
			expect(text(join(t.ui, ".env.local"))).toBe("SECRET=1\n");
			expect(
				all.find((x) => x.title === "Fix shell accessibility")?.resultCommit,
			).toBeTruthy();

			// The finished result is in the checkout the request was sent from,
			// committed (a fast-forward), with nothing private or generated.
			const request = all.find((x) => x.slug === created.slug);
			const branch = sh(t.repo, "symbolic-ref", "--short", "HEAD");
			expect(request?.stateReason).toContain(`Merged into ${branch}`);
			const mine = sh(t.repo, "ls-files");
			for (const file of ["src/store.js", "src/shell.js", "src/views.js"]) {
				expect(mine).toContain(file);
			}
			expect(sh(t.repo, "status", "--porcelain")).toBe("");
			expect(sh(t.repo, "rev-parse", "HEAD")).toBe(
				sh(t.repo, "rev-parse", "ade/frontend"),
			);
		}, 120_000);

		it("a finished request leaves the user's checkout alone when its uncommitted work is in the way, and says where the result is", async () => {
			const t = await team("dirty");
			// The user is editing README.md in their checkout; the result changes it too.
			writeFileSync(join(t.repo, "README.md"), "# My notes\n");
			fake.setSteps([
				{
					name: "split",
					text: '```json\n{"subtasks": [{"title": "Readme", "description": "Docs.", "specialist": "Frontend", "route": "quick", "dependsOn": []}], "reason": "one feature"}\n```',
					cost: 0.01,
				},
				{
					name: "readme",
					write: { "README.md": "# Calendar app\n", ...done },
					cost: 0.01,
				},
				{ name: "readme-review", text: "VERDICT: PASS", cost: 0.01 },
			]);
			const head = sh(t.repo, "rev-parse", "HEAD");
			const created = await tasks.createTask({
				workspaceId: t.ids.lead,
				description: "Write the readme",
				split: true,
			});
			await controller.idle();
			const all = (await tasks.getProjectTasks({ workspaceId: t.ids.lead }))
				.tasks;
			const request = all.find((x) => x.slug === created.slug);
			expect(request?.state).toBe("done");
			expect(request?.stateReason).toContain("is still only in Frontend Agent");
			expect(request?.stateReason).toContain("git merge ade/frontend");
			expect(sh(t.repo, "rev-parse", "HEAD")).toBe(head);
			expect(text(join(t.repo, "README.md"))).toBe("# My notes\n");
		}, 120_000);

		it("with delivery off, the result stays on the agent's branch", async () => {
			const settings = await import(
				"main/lib/agent-workflow/workflow-settings"
			);
			const saved = settings.loadWorkflowSettings(TEST_HOME);
			settings.saveWorkflowSettings(TEST_HOME, {
				...saved,
				execution: { ...saved.execution, deliverResult: false },
			});
			try {
				const t = await team("nodeliver");
				fake.setSteps([
					{
						name: "split",
						text: '```json\n{"subtasks": [{"title": "Store", "description": "Store.", "specialist": "Frontend", "route": "quick", "dependsOn": []}], "reason": "one feature"}\n```',
						cost: 0.01,
					},
					{
						name: "store",
						write: { "src/store.js": "export const store = 1;\n", ...done },
						cost: 0.01,
					},
					{ name: "store-review", text: "VERDICT: PASS", cost: 0.01 },
				]);
				const head = sh(t.repo, "rev-parse", "HEAD");
				const created = await tasks.createTask({
					workspaceId: t.ids.lead,
					description: "Add the store",
					split: true,
				});
				await controller.idle();
				const request = (
					await tasks.getProjectTasks({ workspaceId: t.ids.lead })
				).tasks.find((x) => x.slug === created.slug);
				expect(request?.state).toBe("done");
				expect(request?.stateReason).toContain(
					"The work is in Frontend Agent (ade/frontend)",
				);
				expect(sh(t.repo, "rev-parse", "HEAD")).toBe(head);
			} finally {
				settings.saveWorkflowSettings(TEST_HOME, saved);
			}
		}, 120_000);

		it("someone's uncommitted file that differs from the incoming one pauses the request with its exact path, touching nothing", async () => {
			const t = await team("clash");
			// Uncommitted work in the Frontend folder that is no task's.
			mkdirSync(join(t.fe, "src"), { recursive: true });
			writeFileSync(
				join(t.fe, "src", "theme.js"),
				"export const theme = 'mine';\n",
			);
			fake.setSteps([
				{
					name: "split",
					text: '```json\n{"subtasks": [{"title": "Shell theme", "description": "Theme.", "specialist": "UI", "route": "quick", "dependsOn": []}, {"title": "Views", "description": "Views.", "specialist": "Frontend", "route": "quick", "dependsOn": [1]}], "reason": "shell first"}\n```',
					cost: 0.01,
				},
				{
					name: "shell",
					write: { "src/theme.js": "export const theme = 'ui';\n", ...done },
					cost: 0.01,
				},
				{ name: "shell-review", text: "VERDICT: PASS", cost: 0.01 },
			]);
			const head = sh(t.fe, "rev-parse", "HEAD");
			const created = await tasks.createTask({
				workspaceId: t.ids.lead,
				description: "Theme, then views",
				split: true,
			});
			await controller.idle();
			const all = (await tasks.getProjectTasks({ workspaceId: t.ids.lead }))
				.tasks;
			const views = all.find((x) => x.title === "Views");
			expect(views?.state).toBe("paused");
			expect(views?.stateReason).toContain("src/theme.js");
			expect(views?.stateReason).not.toContain("Merge it yourself");
			expect(all.find((x) => x.slug === created.slug)?.state).toBe("paused");
			expect(sh(t.fe, "rev-parse", "HEAD")).toBe(head);
			expect(text(join(t.fe, "src", "theme.js"))).toBe(
				"export const theme = 'mine';\n",
			);
			await tasks.cancel({ workspaceId: t.ids.lead, slug: created.slug });
		}, 120_000);
	},
);
