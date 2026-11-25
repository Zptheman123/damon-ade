import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { SiVercel } from "react-icons/si";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { VercelSitePanel } from "./components/VercelSitePanel";
import { deploymentState } from "./utils/deploymentState";

/**
 * "Vercel" in the team's top bar: link the team to its website on Vercel,
 * then see whether it is live and its latest deployments at a glance.
 */
export function VercelSite({ workspaceId }: { workspaceId: string }) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const deferredSearch = useDeferredValue(search);
	const navigate = useNavigate();
	const openInBrowserPane = useTabsStore((s) => s.openInBrowserPane);
	const utils = electronTrpc.useUtils();
	const openUrl = electronTrpc.external.openUrl.useMutation();

	const status = electronTrpc.vercel.status.useQuery();
	const connected = !!status.data?.connected;
	const site = electronTrpc.vercel.site.useQuery(
		{ workspaceId },
		{
			enabled: connected,
			// A deploy in progress shows up without reopening ADE.
			refetchInterval: open ? 15_000 : 60_000,
			retry: false,
		},
	);
	const linked = !!site.data?.link;
	const projects = electronTrpc.vercel.projects.useQuery(
		{ search: deferredSearch || undefined },
		{ enabled: connected && open && !linked, retry: false },
	);

	const refresh = () => void utils.vercel.site.invalidate({ workspaceId });
	const link = electronTrpc.vercel.link.useMutation({
		onSuccess: (result) => {
			toast.success(`This team is now linked to ${result.projectName}`);
			setSearch("");
			refresh();
		},
		onError: (error) => toast.error(error.message),
	});
	const unlink = electronTrpc.vercel.unlink.useMutation({
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});

	const latestProduction = site.data?.deployments?.find(
		(d) => d.target === "production",
	);
	const state = latestProduction
		? deploymentState(latestProduction.state)
		: null;
	const label = site.data?.link?.projectName ?? "Vercel";

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex h-7 max-w-40 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted hover:text-foreground",
						linked ? "text-foreground" : "text-muted-foreground",
					)}
					title={
						!connected
							? "Connect this team to its website on Vercel"
							: linked
								? `${label}${state ? `: ${state.label}` : ""}. Its live site and deployments`
								: "Link this team to its website on Vercel"
					}
					data-vercel-site={linked ? "linked" : connected ? "unlinked" : "off"}
				>
					<SiVercel className="size-3 shrink-0" aria-hidden />
					<span className="truncate">{label}</span>
					{state && (
						<span
							className={cn("size-1.5 shrink-0 rounded-full", state.dot)}
							aria-hidden
						/>
					)}
					{state && <span className="sr-only">{state.label}</span>}
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-3">
				<VercelSitePanel
					connected={connected}
					loading={site.isLoading || projects.isLoading}
					error={site.data?.error ?? projects.error?.message}
					linkedName={site.data?.link?.projectName ?? null}
					project={site.data?.project}
					deployments={site.data?.deployments}
					suggestion={search ? null : site.data?.suggestion}
					projects={projects.data}
					search={search}
					busy={link.isPending || unlink.isPending}
					onSearch={setSearch}
					onConnect={() => {
						setOpen(false);
						void navigate({ to: "/settings/integrations" });
					}}
					onLink={(vercelProjectId) =>
						link.mutate({ workspaceId, vercelProjectId })
					}
					onUnlink={() => unlink.mutate({ workspaceId })}
					onOpen={(url) => openUrl.mutate(url)}
					onOpenInPane={(url) => {
						setOpen(false);
						openInBrowserPane(workspaceId, url);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}
