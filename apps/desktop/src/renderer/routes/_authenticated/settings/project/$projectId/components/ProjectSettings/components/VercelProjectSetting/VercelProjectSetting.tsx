import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { toast } from "@superset/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Team Settings > Vercel: the one Vercel project this team deploys to. The
 * user chooses it here (from every scope the token reaches); ADE then
 * points each of the team's folders at it, and the agents never pick one.
 */
export function VercelProjectSetting({ projectId }: { projectId: string }) {
	const navigate = useNavigate();
	const utils = electronTrpc.useUtils();
	const [picking, setPicking] = useState(false);
	const [search, setSearch] = useState("");
	const deferredSearch = useDeferredValue(search);

	const status = electronTrpc.vercel.status.useQuery();
	const connected = !!status.data?.connected;
	const site = electronTrpc.vercel.site.useQuery(
		{ projectId },
		{ enabled: connected, retry: false },
	);
	const link = site.data?.link ?? null;
	const showPicker = connected && !site.isLoading && (picking || !link);
	const scopes = electronTrpc.vercel.allProjects.useQuery(
		{ search: deferredSearch || undefined },
		{ enabled: showPicker, retry: false },
	);

	const refresh = () => void utils.vercel.site.invalidate();
	const linkProject = electronTrpc.vercel.link.useMutation({
		onSuccess: (result) => {
			toast.success(`This team now deploys to ${result.projectName}`);
			setPicking(false);
			setSearch("");
			refresh();
		},
		onError: (error) => toast.error(error.message),
	});
	const unlink = electronTrpc.vercel.unlink.useMutation({
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	const busy = linkProject.isPending || unlink.isPending;

	if (status.isLoading) {
		return <p className="text-xs text-muted-foreground">Checking Vercel…</p>;
	}

	if (!connected) {
		return (
			<div className="flex items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">
					Connect your Vercel account once (Settings &gt; Integrations), then
					choose this team's project here.
				</p>
				<Button
					size="sm"
					variant="outline"
					onClick={() => void navigate({ to: "/settings/integrations" })}
				>
					Connect Vercel
				</Button>
			</div>
		);
	}

	const suggestion = !link && !search ? site.data?.suggestion : null;

	return (
		<div className="space-y-3" data-vercel-team-setting>
			{link && (
				<div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
					<div className="min-w-0">
						<p className="text-sm">
							Deploys to <span className="font-medium">{link.projectName}</span>
							<span className="text-muted-foreground">
								{" "}
								·{" "}
								{link.teamName ||
									(link.teamId ? "Vercel team" : "Personal account")}
							</span>
						</p>
						{site.data?.project?.productionUrl && (
							<p className="truncate text-xs text-muted-foreground">
								{site.data.project.productionUrl}
							</p>
						)}
						{site.data?.error && (
							<p className="text-xs text-destructive">{site.data.error}</p>
						)}
					</div>
					<div className="flex shrink-0 gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => setPicking((p) => !p)}
						>
							{picking ? "Cancel" : "Change"}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => unlink.mutate({ projectId })}
						>
							Unlink
						</Button>
					</div>
				</div>
			)}

			{showPicker && (
				<div className="space-y-2">
					<Input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search your Vercel projects"
						className="h-8 text-sm"
					/>
					{suggestion && (
						<button
							type="button"
							disabled={busy}
							onClick={() =>
								linkProject.mutate({
									projectId,
									vercelProjectId: suggestion.project.id,
								})
							}
							className="w-full rounded-md border border-dashed px-3 py-2 text-left text-sm hover:bg-muted"
						>
							<span className="font-medium">{suggestion.project.name}</span>
							<span className="text-xs text-muted-foreground">
								{" "}
								· suggested: {suggestion.because}
							</span>
						</button>
					)}
					{scopes.isLoading && (
						<p className="text-xs text-muted-foreground">Loading projects…</p>
					)}
					{scopes.error && (
						<p className="text-xs text-destructive">{scopes.error.message}</p>
					)}
					<div className="max-h-72 space-y-3 overflow-y-auto">
						{scopes.data?.map((scope) => (
							<div key={scope.teamId ?? "personal"} className="space-y-1">
								<p className="text-xs font-medium text-muted-foreground">
									{scope.scopeName}
								</p>
								{scope.projects.length === 0 && (
									<p className="text-xs text-muted-foreground">No projects.</p>
								)}
								{scope.projects.map((p) => (
									<button
										key={p.id}
										type="button"
										disabled={busy}
										aria-pressed={link?.projectId === p.id}
										onClick={() =>
											linkProject.mutate({
												projectId,
												vercelProjectId: p.id,
												teamId: scope.teamId,
												teamName: scope.teamId ? scope.scopeName : null,
											})
										}
										className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-1.5 text-left text-sm hover:bg-muted aria-pressed:bg-muted"
									>
										<span className="truncate">{p.name}</span>
										<span className="truncate text-xs text-muted-foreground">
											{p.repo ?? p.productionUrl}
										</span>
									</button>
								))}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
