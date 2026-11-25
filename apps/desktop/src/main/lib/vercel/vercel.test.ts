import { afterAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig } from "main/lib/project-type/config";
import {
	type Cipher,
	clearVercelConnection,
	loadVercelToken,
	saveVercelConnection,
} from "./connection";
import {
	createVercelMcpHandler,
	removeVercelMcpConfigs,
	syncVercelMcpConfig,
	VERCEL_READ_TOOL_RULES,
} from "./mcp";
import {
	removeVercelProjectFile,
	writeVercelProjectFile,
} from "./project-file";
import { allVercelProjects, linkTeamToVercel, teamSite } from "./service";
import { suggestVercelProject } from "./suggest";

/**
 * Vercel with a fake API (no network, no real token) and a fake key store.
 */

const tmp = mkdtempSync(join(tmpdir(), "ade-vercel-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const cipher: Cipher = {
	available: () => true,
	encrypt: (plain) => Buffer.from(`enc:${plain}`),
	decrypt: (data) => data.toString().replace(/^enc:/, ""),
};

const TOKEN = "vercel-test-token-123";

const PROJECT = {
	id: "prj_cal",
	name: "calendar-site",
	framework: "nextjs",
	link: { type: "github", org: "zane", repo: "calendar" },
	targets: { production: { alias: ["calendar.example.com"] } },
};

const DEPLOYMENTS = [
	{
		uid: "dpl_new",
		url: "calendar-abc.vercel.app",
		readyState: "ERROR",
		target: "production",
		created: Date.now() - 60_000,
		meta: { githubCommitRef: "main", githubCommitMessage: "Add events" },
	},
	{
		uid: "dpl_old",
		url: "calendar-xyz.vercel.app",
		readyState: "READY",
		target: "production",
		created: Date.now() - 3_600_000,
		meta: {},
	},
];

function fakeVercel() {
	const calls: Array<{
		path: string;
		auth: string | null;
		teamId: string | null;
	}> = [];
	const fetchFn = (async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		const auth =
			(init?.headers as Record<string, string> | undefined)?.Authorization ??
			null;
		calls.push({
			path: url.pathname,
			auth,
			teamId: url.searchParams.get("teamId"),
		});
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status });
		if (auth !== `Bearer ${TOKEN}`) {
			return json({ error: { message: "Invalid token" } }, 403);
		}
		switch (url.pathname) {
			case "/v2/user":
				return json({ user: { id: "u1", username: "zane", name: "Zane" } });
			case "/v2/teams":
				return json({
					teams: [{ id: "team_acme", slug: "acme", name: "Acme" }],
				});
			case "/v10/projects":
				return json({
					projects: url.searchParams.get("teamId")
						? [{ id: "prj_shop", name: "shop" }]
						: [PROJECT, { id: "prj_other", name: "blog" }],
				});
			case "/v10/projects/prj_cal":
			case "/v10/projects/calendar-site":
				return json(PROJECT);
			case "/v6/deployments":
				return json({ deployments: DEPLOYMENTS });
			case "/v3/deployments/dpl_new/events":
				return json([
					{ created: 2, text: "Error: Cannot find module 'date-fns'" },
					{ created: 1, payload: { text: "Running build" } },
				]);
			case "/v10/projects/prj_cal/env":
				return json({
					envs: [
						{ key: "DATABASE_URL", target: ["production"], value: "secret!" },
					],
				});
			default:
				return json({ error: { message: "not found" } }, 404);
		}
	}) as typeof fetch;
	return { calls, fetchFn };
}

function setup(name: string) {
	const homeDir = join(tmp, name, "home");
	const root = join(tmp, name, "calendar");
	mkdirSync(root, { recursive: true });
	const { calls, fetchFn } = fakeVercel();
	const deps = { homeDir, cipher, fetchFn };
	return { homeDir, root, calls, deps };
}

function connect(homeDir: string) {
	saveVercelConnection(homeDir, cipher, TOKEN, {
		username: "zane",
		teamId: null,
		connectedAt: new Date().toISOString(),
	});
}

async function callTool(
	handler: ReturnType<typeof createVercelMcpHandler>,
	name: string,
	args: Record<string, unknown> = {},
) {
	const reply = (await handler("ws-1", {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	})) as { result: { content: Array<{ text: string }>; isError?: boolean } };
	return {
		text: reply.result.content[0].text,
		isError: !!reply.result.isError,
	};
}

describe("Vercel", () => {
	it("keeps the token encrypted, and forgets it on disconnect", () => {
		const { homeDir } = setup("token");
		connect(homeDir);
		const stored = readFileSync(join(homeDir, "vercel", "token.bin"), "utf8");
		expect(stored).toBe(`enc:${TOKEN}`);
		expect(loadVercelToken(homeDir, cipher)).toBe(TOKEN);
		clearVercelConnection(homeDir);
		expect(loadVercelToken(homeDir, cipher)).toBeNull();
	});

	it("does not store a token without a secure key store", () => {
		const { homeDir } = setup("nostore");
		expect(() =>
			saveVercelConnection(
				homeDir,
				{ ...cipher, available: () => false },
				TOKEN,
				{ username: "zane", teamId: null, connectedAt: "" },
			),
		).toThrow(/secure key store/);
		expect(existsSync(join(homeDir, "vercel", "token.bin"))).toBe(false);
	});

	it("suggests the project that deploys this folder's Git repository", () => {
		const { root } = setup("suggest");
		mkdirSync(join(root, ".git"), { recursive: true });
		writeFileSync(
			join(root, ".git", "config"),
			'[remote "origin"]\n\turl = https://github.com/Zane/calendar.git\n',
		);
		const suggestion = suggestVercelProject(root, [
			{ id: "prj_other", name: "blog", productionUrl: "" },
			{
				id: "prj_cal",
				name: "calendar-site",
				repo: "zane/calendar",
				productionUrl: "",
			},
		]);
		expect(suggestion?.project.id).toBe("prj_cal");
		expect(suggestion?.because).toContain("zane/calendar");
	});

	it("links the team, then shows its site and deployments", async () => {
		const { homeDir, root, deps, calls } = setup("site");
		expect((await teamSite(deps, root)).connected).toBe(false);
		connect(homeDir);
		const unlinked = await teamSite(deps, root);
		expect(unlinked.link).toBeNull();

		await linkTeamToVercel(deps, root, "calendar-site");
		expect(loadProjectConfig(homeDir, root).vercel).toMatchObject({
			projectId: "prj_cal",
			projectName: "calendar-site",
			teamId: null,
			// The personal account: the CLI names it by the user's id.
			orgId: "u1",
		});
		const site = await teamSite(deps, root);
		expect(site.project?.productionUrl).toBe("https://calendar.example.com");
		expect(site.deployments?.[0]).toMatchObject({
			id: "dpl_new",
			state: "ERROR",
			branch: "main",
		});
		expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
	});

	it("gives agents read-only tools: the site, build logs, variable names (no values)", async () => {
		const { homeDir, root, deps } = setup("mcp");
		const handler = createVercelMcpHandler(() => ({
			...deps,
			rootOf: () => root,
		}));
		connect(homeDir);

		const notLinked = await callTool(handler, "vercel_site");
		expect(notLinked.isError).toBe(true);
		expect(notLinked.text).toContain("Team Settings");

		await linkTeamToVercel(deps, root, "prj_cal");
		const site = await callTool(handler, "vercel_site");
		expect(site.text).toContain("Live at https://calendar.example.com");
		expect(site.text).toContain("dpl_new ERROR production");
		expect(site.text).toContain('"Add events"');

		// No id: the latest deployment failed, so its log, oldest line first.
		const log = await callTool(handler, "vercel_build_logs");
		expect(log.text).toContain("ERROR production deployment dpl_new");
		expect(log.text.indexOf("Running build")).toBeLessThan(
			log.text.indexOf("Cannot find module"),
		);

		const envs = await callTool(handler, "vercel_env_names");
		expect(envs.text).toContain("DATABASE_URL (production)");
		expect(envs.text).not.toContain("secret!");

		// The token never reaches what the agents read.
		for (const t of [site, log, envs]) expect(t.text).not.toContain(TOKEN);

		const list = (await handler("ws-1", {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
		})) as { result: { tools: Array<{ name: string }> } };
		const names = list.result.tools.map((t) => t.name);
		// The team's project is the user's choice: no tool lists or links projects.
		expect(names).not.toContain("vercel_link_project");
		expect(names).not.toContain("vercel_projects");
		expect(names.some((n) => /deploy$|redeploy|delete|set_env/.test(n))).toBe(
			false,
		);
		expect(VERCEL_READ_TOOL_RULES).toHaveLength(names.length);

		// The agents are told which project, by name.
		const init = (await handler("ws-1", {
			jsonrpc: "2.0",
			id: 3,
			method: "initialize",
			params: { protocolVersion: "2025-06-18" },
		})) as { result: { instructions: string } };
		expect(init.result.instructions).toContain(
			`This team's Vercel project is "calendar-site"`,
		);
		expect(init.result.instructions).toContain("never choose, link or create");
	});

	it("lists every scope's projects and links one from a Vercel team", async () => {
		const { homeDir, root, deps, calls } = setup("scopes");
		connect(homeDir);
		const scopes = await allVercelProjects(deps);
		expect(
			scopes.map((s) => [s.scopeName, s.projects.map((p) => p.name)]),
		).toEqual([
			["Personal account", ["calendar-site", "blog"]],
			["Acme", ["shop"]],
		]);
		const link = await linkTeamToVercel(deps, root, "prj_cal", {
			teamId: "team_acme",
			teamName: "Acme",
		});
		expect(link).toMatchObject({
			teamId: "team_acme",
			teamName: "Acme",
			orgId: "team_acme",
		});
		expect(calls.find((c) => c.path === "/v10/projects/prj_cal")?.teamId).toBe(
			"team_acme",
		);
	});

	it("points a folder's Vercel CLI at the team's project, and nothing else", () => {
		const folder = join(tmp, "cli-folder");
		mkdirSync(join(folder, ".vercel"), { recursive: true });
		const file = join(folder, ".vercel", "project.json");
		writeFileSync(
			file,
			JSON.stringify({ projectId: "prj_old", orgId: "u1", settings: { a: 1 } }),
		);
		const link = {
			projectId: "prj_cal",
			projectName: "calendar-site",
			teamId: null,
			orgId: "u1",
			linkedAt: "",
		};
		expect(writeVercelProjectFile(folder, link)).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			projectId: "prj_cal",
			orgId: "u1",
			projectName: "calendar-site",
			settings: { a: 1 },
		});
		// The folder ignores itself, so it never reaches a commit.
		expect(readFileSync(join(folder, ".vercel", ".gitignore"), "utf8")).toBe(
			"*\n",
		);
		expect(writeVercelProjectFile(folder, link)).toBe(false);
		// No owner known yet, or no folder: nothing is written.
		expect(writeVercelProjectFile(folder, { ...link, orgId: undefined })).toBe(
			false,
		);
		expect(writeVercelProjectFile(join(tmp, "missing"), link)).toBe(false);
		// Unlinking removes only the project it wrote.
		removeVercelProjectFile(folder, "prj_other");
		expect(existsSync(file)).toBe(true);
		removeVercelProjectFile(folder, "prj_cal");
		expect(existsSync(file)).toBe(false);
	});

	it("a bad token is reported, not crashed on", async () => {
		const { homeDir, root, deps } = setup("badtoken");
		saveVercelConnection(homeDir, cipher, "wrong-token", {
			username: "zane",
			teamId: null,
			connectedAt: "",
		});
		const site = await teamSite(deps, root);
		expect(site.error).toContain("Vercel refused the token");
	});

	it("writes the agents' MCP config only while connected", () => {
		const { homeDir, deps } = setup("config");
		expect(syncVercelMcpConfig(deps, "ws-1", 51741)).toBeUndefined();
		connect(homeDir);
		const path = syncVercelMcpConfig(deps, "ws-1", 51741);
		expect(path).toBeDefined();
		const config = JSON.parse(readFileSync(path as string, "utf8"));
		const server = config.mcpServers["ade-vercel"];
		expect(server.url).toBe("http://127.0.0.1:51741/vercel-mcp/ws-1");
		// The local token, not the Vercel token.
		expect(JSON.stringify(config)).not.toContain(TOKEN);
		removeVercelMcpConfigs(homeDir);
		expect(existsSync(path as string)).toBe(false);
	});
});
