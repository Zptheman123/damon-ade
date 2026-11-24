/**
 * A small client for Vercel's REST API (https://vercel.com/docs/rest-api),
 * used only in ADE's main process: the token never reaches the renderer
 * or a model. Read calls only; ADE never deploys or changes a project.
 */

const BASE = "https://api.vercel.com";

export interface VercelUser {
	id: string;
	username: string;
	name?: string | null;
}

export interface VercelTeam {
	id: string;
	slug: string;
	name?: string | null;
}

export interface VercelProject {
	id: string;
	name: string;
	framework?: string | null;
	/** Its Git repository, when connected. */
	repo?: string;
	productionUrl: string;
	updatedAt?: number;
}

export type DeploymentState =
	| "BUILDING"
	| "ERROR"
	| "INITIALIZING"
	| "QUEUED"
	| "READY"
	| "CANCELED"
	| "DELETED";

export interface VercelDeployment {
	id: string;
	url: string;
	state: DeploymentState | string;
	target: "production" | "preview" | string;
	createdAt: number;
	branch?: string;
	commitMessage?: string;
	inspectorUrl?: string;
}

export interface VercelEnvName {
	key: string;
	targets: string[];
}

export class VercelApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

type Fetch = typeof fetch;

interface RawProject {
	id: string;
	name: string;
	framework?: string | null;
	updatedAt?: number;
	link?: { type?: string; org?: string; repo?: string; repoSlug?: string };
	targets?: { production?: { alias?: string[]; url?: string } };
	alias?: Array<{ domain?: string } | string>;
}

function projectOf(raw: RawProject): VercelProject {
	const alias =
		raw.targets?.production?.alias?.[0] ??
		raw.alias?.map((a) => (typeof a === "string" ? a : a.domain)).find(Boolean);
	const repo =
		raw.link?.org && (raw.link.repo || raw.link.repoSlug)
			? `${raw.link.org}/${raw.link.repo ?? raw.link.repoSlug}`
			: undefined;
	return {
		id: raw.id,
		name: raw.name,
		framework: raw.framework ?? null,
		repo,
		productionUrl: `https://${alias ?? `${raw.name}.vercel.app`}`,
		updatedAt: raw.updatedAt,
	};
}

interface RawDeployment {
	uid: string;
	url: string;
	state?: string;
	readyState?: string;
	target?: string | null;
	created?: number;
	createdAt?: number;
	inspectorUrl?: string;
	meta?: Record<string, string | undefined>;
}

function deploymentOf(raw: RawDeployment): VercelDeployment {
	return {
		id: raw.uid,
		url: raw.url.startsWith("http") ? raw.url : `https://${raw.url}`,
		state: raw.readyState ?? raw.state ?? "UNKNOWN",
		target: raw.target ?? "preview",
		createdAt: raw.createdAt ?? raw.created ?? 0,
		branch: raw.meta?.githubCommitRef ?? raw.meta?.gitlabCommitRef,
		commitMessage:
			raw.meta?.githubCommitMessage ?? raw.meta?.gitlabCommitMessage,
		inspectorUrl: raw.inspectorUrl,
	};
}

export class VercelApi {
	constructor(
		private token: string,
		/** The team the calls act in (null: the personal account). */
		private teamId: string | null = null,
		private fetchFn: Fetch = fetch,
	) {}

	private async get<T>(
		path: string,
		query: Record<string, string | number | undefined> = {},
		scoped = true,
	): Promise<T> {
		const url = new URL(path, BASE);
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		if (scoped && this.teamId) url.searchParams.set("teamId", this.teamId);
		const response = await this.fetchFn(url, {
			headers: { Authorization: `Bearer ${this.token}` },
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			let detail = "";
			try {
				const body = (await response.json()) as {
					error?: { message?: string };
				};
				detail = body.error?.message ?? "";
			} catch {
				// No JSON body.
			}
			throw new VercelApiError(
				response.status === 401 || response.status === 403
					? `Vercel refused the token${detail ? `: ${detail}` : ""}. Connect again in Settings > Integrations.`
					: `Vercel answered ${response.status}${detail ? `: ${detail}` : ""}`,
				response.status,
			);
		}
		return (await response.json()) as T;
	}

	async user(): Promise<VercelUser> {
		const body = await this.get<{ user: VercelUser }>("/v2/user", {}, false);
		return {
			id: body.user.id,
			username: body.user.username,
			name: body.user.name ?? null,
		};
	}

	async teams(): Promise<VercelTeam[]> {
		const body = await this.get<{ teams?: VercelTeam[] }>(
			"/v2/teams",
			{ limit: 100 },
			false,
		);
		return (body.teams ?? []).map((t) => ({
			id: t.id,
			slug: t.slug,
			name: t.name ?? null,
		}));
	}

	async projects(search?: string): Promise<VercelProject[]> {
		const body = await this.get<{ projects?: RawProject[] }>("/v10/projects", {
			limit: 100,
			search: search?.trim() || undefined,
		});
		return (body.projects ?? []).map(projectOf);
	}

	async project(idOrName: string): Promise<VercelProject> {
		return projectOf(
			await this.get<RawProject>(
				`/v10/projects/${encodeURIComponent(idOrName)}`,
			),
		);
	}

	async deployments(
		projectId: string,
		options: { limit?: number; target?: "production" | "preview" } = {},
	): Promise<VercelDeployment[]> {
		const body = await this.get<{ deployments?: RawDeployment[] }>(
			"/v6/deployments",
			{
				projectId,
				limit: Math.min(Math.max(options.limit ?? 10, 1), 50),
				target: options.target,
			},
		);
		return (body.deployments ?? []).map(deploymentOf);
	}

	/** A deployment's build output, oldest line first. */
	async buildLog(deploymentId: string, limit = 400): Promise<string[]> {
		const body = await this.get<
			Array<{
				created?: number;
				text?: string;
				payload?: { text?: string; created?: number };
			}>
		>(`/v3/deployments/${encodeURIComponent(deploymentId)}/events`, {
			builds: 1,
			follow: 0,
			// The newest lines: the end of the log is where builds fail.
			direction: "backward",
			limit,
		});
		return (Array.isArray(body) ? body : [])
			.map((e, i) => ({
				at: e.created ?? e.payload?.created ?? i,
				text: e.text ?? e.payload?.text ?? "",
			}))
			.filter((e) => e.text.length > 0)
			.sort((a, b) => a.at - b.at)
			.map((e) => e.text);
	}

	/** The names of a project's environment variables, never their values. */
	async envNames(projectId: string): Promise<VercelEnvName[]> {
		const body = await this.get<{
			envs?: Array<{ key: string; target?: string[] | string }>;
		}>(`/v10/projects/${encodeURIComponent(projectId)}/env`);
		return (body.envs ?? []).map((e) => ({
			key: e.key,
			targets: Array.isArray(e.target) ? e.target : e.target ? [e.target] : [],
		}));
	}
}
