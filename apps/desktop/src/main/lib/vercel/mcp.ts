import {
	chmodSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getLocalToken } from "main/lib/notifications/local-auth";
import { loadProjectConfig } from "main/lib/project-type/config";
import {
	ago,
	isVercelConnected,
	linkTeamToVercel,
	teamSite,
	type VercelDeps,
	vercelApi,
} from "./service";

/**
 * The agents' Vercel tools, as an MCP server on ADE's local HTTP server
 * (127.0.0.1, behind the "vercel" token in each config file, 0600). ADE
 * makes the Vercel calls with the user's token; the agents only see the
 * answers. They can read the team's website, its deployments, build logs
 * and the names of its environment variables. They cannot deploy, change
 * settings or read secret values. Linking the team to a project is the one
 * change, and Claude Code asks the user before each such call.
 */

export const VERCEL_MCP_NAME = "ade-vercel";

const INSTRUCTIONS = `Vercel tools for this ADE team's website (the user connected their Vercel account in ADE).
- vercel_site shows the live site, its address and its latest deployments. Use it when the work concerns the deployed website, or when the user asks whether it is live.
- When a deployment failed, read vercel_build_logs, find the cause in the code and fix it there. A new deployment starts when the fix is pushed to the project's Git repository; you cannot deploy from here.
- vercel_env_names lists environment variable names (never their values), to check that a variable the code needs exists in production.
- If the team is not linked to a project yet, vercel_projects lists the user's projects; ask the user which one before calling vercel_link_project.`;

const READ_TOOLS = [
	{
		name: "vercel_site",
		description:
			"The team's Vercel project: its live address, framework, Git repository and latest deployments (state, branch, commit, when).",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "vercel_deployments",
		description: "The team's latest deployments on Vercel.",
		inputSchema: {
			type: "object",
			properties: {
				target: {
					type: "string",
					enum: ["production", "preview"],
					description: "Only production or only preview deployments.",
				},
				limit: { type: "number", description: "How many (1 to 20)." },
			},
		},
	},
	{
		name: "vercel_build_logs",
		description:
			"A deployment's build log (its last lines). Without an id: the latest deployment, or the latest failed one when the latest failed.",
		inputSchema: {
			type: "object",
			properties: {
				deployment: {
					type: "string",
					description: "A deployment id (dpl_…) from vercel_deployments.",
				},
			},
		},
	},
	{
		name: "vercel_env_names",
		description:
			"The names of the project's environment variables and where each applies (production, preview, development). Never their values.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "vercel_projects",
		description: "The user's Vercel projects, to find the team's website.",
		inputSchema: {
			type: "object",
			properties: {
				search: { type: "string", description: "Part of the name." },
			},
		},
	},
] as const;

const TOOLS = [
	...READ_TOOLS,
	{
		name: "vercel_link_project",
		description:
			"Connect this ADE team to one of the user's Vercel projects (its website). Only after the user chose the project.",
		inputSchema: {
			type: "object",
			properties: {
				project: { type: "string", description: "The project's name or id." },
			},
			required: ["project"],
		},
	},
];

/** Tools that only read: allowed without asking (Team chat, task runs). */
export const VERCEL_READ_TOOL_RULES = READ_TOOLS.map(
	(t) => `mcp__${VERCEL_MCP_NAME}__${t.name}`,
);

const MAX_LOG_CHARS = 20_000;

function text(value: string, isError = false) {
	return {
		content: [{ type: "text", text: value }],
		...(isError ? { isError } : {}),
	};
}

function writePrivate(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort (no-op on Windows, where the profile folder is private).
	}
}

const configDir = (homeDir: string) => join(homeDir, "vercel-mcp");

/** Where a workspace's Vercel MCP config lives (it may not exist). */
export function vercelMcpConfigPath(
	homeDir: string,
	workspaceId: string,
): string {
	return join(configDir(homeDir), `${workspaceId}.mcp.json`);
}

/** The Vercel server's entry in an MCP config (`mcpServers`). */
export function vercelMcpServer(
	homeDir: string,
	workspaceId: string,
	port: number,
) {
	return {
		type: "http",
		url: `http://127.0.0.1:${port}/vercel-mcp/${encodeURIComponent(workspaceId)}`,
		headers: {
			Authorization: `Bearer ${getLocalToken(homeDir, "vercel")}`,
		},
	};
}

/**
 * Write the workspace's Vercel MCP config while Vercel is connected, and
 * remove it otherwise. Returns its path when it exists.
 */
export function syncVercelMcpConfig(
	deps: VercelDeps,
	workspaceId: string,
	port: number,
): string | undefined {
	const path = vercelMcpConfigPath(deps.homeDir, workspaceId);
	if (!isVercelConnected(deps)) {
		rmSync(path, { force: true });
		return undefined;
	}
	mkdirSync(configDir(deps.homeDir), { recursive: true });
	writePrivate(path, {
		mcpServers: {
			[VERCEL_MCP_NAME]: vercelMcpServer(deps.homeDir, workspaceId, port),
		},
	});
	return path;
}

/** Disconnected: no session gets the Vercel tools any more. */
export function removeVercelMcpConfigs(homeDir: string): void {
	let names: string[] = [];
	try {
		names = readdirSync(configDir(homeDir));
	} catch {
		return;
	}
	for (const name of names) {
		if (name.endsWith(".mcp.json")) {
			rmSync(join(configDir(homeDir), name), { force: true });
		}
	}
}

export interface VercelMcpDeps extends VercelDeps {
	/** The team's repository root for a workspace. */
	rootOf: (workspaceId: string) => string;
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
	id?: JsonRpcId;
	method?: string;
	params?: Record<string, unknown>;
}

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function createVercelMcpHandler(deps: () => VercelMcpDeps) {
	const linked = (workspaceId: string) => {
		const d = deps();
		const root = d.rootOf(workspaceId);
		const link = loadProjectConfig(d.homeDir, root).vercel;
		if (!link) {
			throw new Error(
				"This team is not linked to a Vercel project yet. Call vercel_projects, ask the user which project is the team's website, then vercel_link_project. (The user can also use the Vercel button in ADE's top bar.)",
			);
		}
		return { d, root, link, api: vercelApi(d, link.teamId) };
	};

	const call = async (
		workspaceId: string,
		name: string,
		args: Record<string, unknown>,
	) => {
		switch (name) {
			case "vercel_site": {
				const { d, root } = linked(workspaceId);
				const site = await teamSite(d, root);
				if (site.error) return text(site.error, true);
				const p = site.project;
				if (!p) return text("The project could not be read.", true);
				const lines = (site.deployments ?? []).map(
					(dep) =>
						`- ${dep.id} ${dep.state} ${dep.target} ${ago(dep.createdAt)}${dep.branch ? ` on ${dep.branch}` : ""}${dep.commitMessage ? `: "${dep.commitMessage.split("\n")[0]}"` : ""} ${dep.url}`,
				);
				return text(
					[
						`Vercel project "${p.name}"${p.framework ? ` (${p.framework})` : ""}.`,
						`Live at ${p.productionUrl}.`,
						p.repo
							? `Deploys from the Git repository ${p.repo}.`
							: "Not connected to a Git repository.",
						"",
						"Latest deployments:",
						...(lines.length ? lines : ["- none yet"]),
					].join("\n"),
				);
			}
			case "vercel_deployments": {
				const { link, api } = linked(workspaceId);
				const target =
					args.target === "production" || args.target === "preview"
						? args.target
						: undefined;
				const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
				const list = await api.deployments(link.projectId, { target, limit });
				return text(
					list.length
						? list
								.map(
									(dep) =>
										`- ${dep.id} ${dep.state} ${dep.target} ${ago(dep.createdAt)}${dep.branch ? ` on ${dep.branch}` : ""}${dep.commitMessage ? `: "${dep.commitMessage.split("\n")[0]}"` : ""} ${dep.url}`,
								)
								.join("\n")
						: "No deployments.",
				);
			}
			case "vercel_build_logs": {
				const { link, api } = linked(workspaceId);
				let id = typeof args.deployment === "string" ? args.deployment : "";
				let which = "";
				if (!id) {
					const latest = await api.deployments(link.projectId, { limit: 10 });
					const pick =
						latest[0]?.state === "ERROR"
							? latest[0]
							: (latest.find((dep) => dep.state === "ERROR") ?? latest[0]);
					if (!pick) return text("The project has no deployments yet.");
					id = pick.id;
					which = `${pick.state} ${pick.target} deployment ${pick.id} (${ago(pick.createdAt)})`;
				}
				const lines = await api.buildLog(id);
				let log = lines.join("\n");
				if (log.length > MAX_LOG_CHARS) {
					log = `…(earlier lines left out)\n${log.slice(-MAX_LOG_CHARS)}`;
				}
				return text(
					`Build log of ${which || id}:\n${log || "(empty: the build may not have started yet)"}`,
				);
			}
			case "vercel_env_names": {
				const { link, api } = linked(workspaceId);
				const envs = await api.envNames(link.projectId);
				return text(
					envs.length
						? envs.map((e) => `- ${e.key} (${e.targets.join(", ")})`).join("\n")
						: "No environment variables.",
				);
			}
			case "vercel_projects": {
				const d = deps();
				const search = typeof args.search === "string" ? args.search : "";
				const projects = await vercelApi(d).projects(search);
				return text(
					projects.length
						? projects
								.slice(0, 50)
								.map(
									(p) =>
										`- ${p.name} (${p.id})${p.framework ? `, ${p.framework}` : ""}${p.repo ? `, from ${p.repo}` : ""}, ${p.productionUrl}`,
								)
								.join("\n")
						: "No projects found.",
				);
			}
			case "vercel_link_project": {
				const d = deps();
				const project =
					typeof args.project === "string" ? args.project.trim() : "";
				if (!project) return text("Which project? Give its name or id.", true);
				const link = await linkTeamToVercel(d, d.rootOf(workspaceId), project);
				return text(
					`Linked this team to the Vercel project "${link.projectName}".`,
				);
			}
			default:
				return text(`Unknown tool: ${name}`, true);
		}
	};

	const handleOne = async (workspaceId: string, message: JsonRpcRequest) => {
		const id = message.id ?? null;
		const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
		if (message.id === undefined) return undefined;
		try {
			switch (message.method) {
				case "initialize": {
					const asked = String(message.params?.protocolVersion ?? "");
					return reply({
						protocolVersion: SUPPORTED_VERSIONS.includes(asked)
							? asked
							: SUPPORTED_VERSIONS[0],
						capabilities: { tools: {} },
						serverInfo: { name: VERCEL_MCP_NAME, version: "1.0.0" },
						instructions: INSTRUCTIONS,
					});
				}
				case "ping":
					return reply({});
				case "tools/list":
					return reply({ tools: TOOLS });
				case "tools/call":
					return reply(
						await call(
							workspaceId,
							String(message.params?.name ?? ""),
							(message.params?.arguments ?? {}) as Record<string, unknown>,
						),
					);
				default:
					return {
						jsonrpc: "2.0",
						id,
						error: {
							code: -32601,
							message: `Method not found: ${message.method}`,
						},
					};
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return message.method === "tools/call"
				? reply(text(msg, true))
				: { jsonrpc: "2.0", id, error: { code: -32603, message: msg } };
		}
	};

	return async (workspaceId: string, body: unknown) => {
		if (Array.isArray(body)) {
			const replies = (
				await Promise.all(
					body.map((m) => handleOne(workspaceId, m as JsonRpcRequest)),
				)
			).filter((r) => r !== undefined);
			return replies.length ? replies : undefined;
		}
		return handleOne(workspaceId, (body ?? {}) as JsonRpcRequest);
	};
}
