import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { cn } from "@superset/ui/utils";
import {
	LuExternalLink,
	LuGitBranch,
	LuLink2,
	LuPanelRight,
	LuUnlink2,
} from "react-icons/lu";
import { deploymentState, timeAgo } from "../../utils/deploymentState";

export interface SiteProject {
	id: string;
	name: string;
	productionUrl: string;
	repo?: string;
	framework?: string | null;
}

export interface SiteDeployment {
	id: string;
	url: string;
	state: string;
	target: string;
	createdAt: number;
	branch?: string;
	commitMessage?: string;
	inspectorUrl?: string;
}

interface VercelSitePanelProps {
	connected: boolean;
	loading?: boolean;
	error?: string;
	linkedName?: string | null;
	project?: SiteProject;
	deployments?: SiteDeployment[];
	suggestion?: { project: SiteProject; because: string } | null;
	/** Projects to choose from (search results). */
	projects?: SiteProject[];
	search: string;
	busy?: boolean;
	onSearch: (value: string) => void;
	onConnect: () => void;
	onLink: (projectId: string) => void;
	onUnlink: () => void;
	onOpen: (url: string) => void;
	onOpenInPane: (url: string) => void;
}

/**
 * The team's website on Vercel: connect Vercel, link the team to one of
 * the user's projects, then see the live address and latest deployments.
 */
export function VercelSitePanel({
	connected,
	loading,
	error,
	linkedName,
	project,
	deployments,
	suggestion,
	projects,
	search,
	busy,
	onSearch,
	onConnect,
	onLink,
	onUnlink,
	onOpen,
	onOpenInPane,
}: VercelSitePanelProps) {
	if (!connected) {
		return (
			<div className="space-y-3 text-xs" data-vercel-panel="disconnected">
				<p className="font-medium text-sm">Connect this team to its website</p>
				<p className="text-muted-foreground">
					Connect your Vercel account once in Settings. Then link this team to
					its Vercel project: you see the live site and its deployments here,
					and the agents can read its build logs to fix failed deploys.
				</p>
				<Button size="sm" className="h-7 text-xs" onClick={onConnect}>
					Connect Vercel in Settings
				</Button>
			</div>
		);
	}

	if (!linkedName) {
		const list = (projects ?? []).filter(
			(p) => p.id !== suggestion?.project.id,
		);
		return (
			<div className="space-y-3 text-xs" data-vercel-panel="unlinked">
				<p className="font-medium text-sm">Which website is this team?</p>
				{suggestion && (
					<div className="rounded-md border bg-muted/40 p-2">
						<div className="flex items-center justify-between gap-2">
							<span className="min-w-0">
								<span className="block truncate font-medium">
									{suggestion.project.name}
								</span>
								<span className="block text-[11px] text-muted-foreground">
									Likely: {suggestion.because}
								</span>
							</span>
							<Button
								size="sm"
								className="h-7 shrink-0 gap-1 text-xs"
								disabled={busy}
								onClick={() => onLink(suggestion.project.id)}
							>
								<LuLink2 className="size-3" aria-hidden />
								Link
							</Button>
						</div>
					</div>
				)}
				<Input
					placeholder="Search your Vercel projects"
					aria-label="Search your Vercel projects"
					value={search}
					onChange={(event) => onSearch(event.target.value)}
					className="h-7 text-xs"
				/>
				{error && <p className="text-red-600 dark:text-red-400">{error}</p>}
				<ul className="max-h-56 space-y-1 overflow-y-auto">
					{loading && <li className="text-muted-foreground">Loading…</li>}
					{!loading && !list.length && !suggestion && (
						<li className="text-muted-foreground">No projects found.</li>
					)}
					{list.map((p) => (
						<li
							key={p.id}
							className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-muted"
						>
							<span className="min-w-0">
								<span className="block truncate">{p.name}</span>
								<span className="block truncate text-[11px] text-muted-foreground">
									{p.repo ?? p.productionUrl.replace(/^https:\/\//, "")}
								</span>
							</span>
							<Button
								variant="outline"
								size="sm"
								className="h-6 shrink-0 px-2 text-xs"
								disabled={busy}
								onClick={() => onLink(p.id)}
							>
								Link
							</Button>
						</li>
					))}
				</ul>
			</div>
		);
	}

	const latestProduction = deployments?.find((d) => d.target === "production");
	const live = latestProduction
		? deploymentState(latestProduction.state)
		: null;

	return (
		<div className="space-y-3 text-xs" data-vercel-panel="linked">
			<div className="flex items-start justify-between gap-2">
				<span className="min-w-0">
					<span className="block truncate font-medium text-sm">
						{project?.name ?? linkedName}
					</span>
					{project?.repo && (
						<span className="block truncate text-[11px] text-muted-foreground">
							Deploys from {project.repo}
						</span>
					)}
				</span>
				{live && (
					<span className="flex shrink-0 items-center gap-1 text-[11px]">
						<span className={cn("size-1.5 rounded-full", live.dot)} />
						{live.label}
					</span>
				)}
			</div>
			{error && <p className="text-red-600 dark:text-red-400">{error}</p>}
			{project && (
				<div className="flex items-center gap-1">
					<Button
						size="sm"
						className="h-7 min-w-0 flex-1 justify-start gap-1.5 text-xs"
						onClick={() => onOpen(project.productionUrl)}
						title={`Open ${project.productionUrl} in your browser`}
					>
						<LuExternalLink className="size-3.5 shrink-0" aria-hidden />
						<span className="truncate">
							{project.productionUrl.replace(/^https:\/\//, "")}
						</span>
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-7 px-2"
						aria-label="Open the live site in ADE's preview tab"
						title="Open in ADE's preview tab"
						onClick={() => onOpenInPane(project.productionUrl)}
					>
						<LuPanelRight className="size-3.5" aria-hidden />
					</Button>
				</div>
			)}
			<div>
				<p className="mb-1 text-[11px] font-medium text-muted-foreground uppercase">
					Latest deployments
				</p>
				<ul className="space-y-0.5">
					{loading && !deployments && (
						<li className="text-muted-foreground">Loading…</li>
					)}
					{deployments?.length === 0 && (
						<li className="text-muted-foreground">No deployments yet.</li>
					)}
					{deployments?.map((d) => {
						const s = deploymentState(d.state);
						return (
							<li key={d.id}>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted"
									title={`${s.label}: open it on Vercel`}
									onClick={() => onOpen(d.inspectorUrl ?? d.url)}
								>
									<span
										className={cn("size-1.5 shrink-0 rounded-full", s.dot)}
										aria-hidden
									/>
									<span className="min-w-0 flex-1">
										<span className="block truncate">
											{d.commitMessage?.split("\n")[0] ?? d.url}
										</span>
										<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
											{s.label} · {d.target} ·{" "}
											{d.branch && (
												<>
													<LuGitBranch className="size-2.5" aria-hidden />
													{d.branch} ·{" "}
												</>
											)}
											{timeAgo(d.createdAt)}
										</span>
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>
			<div className="flex items-center justify-between border-t pt-2 text-[11px] text-muted-foreground">
				<span>Agents can read its build logs to fix failed deploys.</span>
				<button
					type="button"
					className="flex shrink-0 items-center gap-1 hover:text-foreground"
					onClick={onUnlink}
					disabled={busy}
				>
					<LuUnlink2 className="size-3" aria-hidden />
					Unlink
				</button>
			</div>
		</div>
	);
}
