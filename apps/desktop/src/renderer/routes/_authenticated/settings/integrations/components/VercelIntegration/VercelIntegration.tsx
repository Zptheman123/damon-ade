import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
} from "@superset/ui/card";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { HiCheckCircle, HiOutlineArrowTopRightOnSquare } from "react-icons/hi2";
import { SiVercel } from "react-icons/si";
import { electronTrpc } from "renderer/lib/electron-trpc";

const TOKEN_PAGE = "https://vercel.com/account/settings/tokens";
const PERSONAL = "personal";

/**
 * Vercel, connected on this computer (no organization needed): the user
 * pastes an access token once; ADE keeps it encrypted, shows each team's
 * website and gives the agents read-only Vercel tools.
 */
export function VercelIntegration() {
	const utils = electronTrpc.useUtils();
	const status = electronTrpc.vercel.status.useQuery();
	const connected = !!status.data?.connected;
	const teams = electronTrpc.vercel.teams.useQuery(undefined, {
		enabled: connected,
		retry: false,
	});
	const [token, setToken] = useState("");
	const openUrl = electronTrpc.external.openUrl.useMutation();

	const refresh = () => void utils.vercel.invalidate();
	const connect = electronTrpc.vercel.connect.useMutation({
		onSuccess: (user) => {
			setToken("");
			toast.success(`Vercel connected as ${user.username}`);
			refresh();
		},
		onError: (error) => toast.error(error.message),
	});
	const disconnect = electronTrpc.vercel.disconnect.useMutation({
		onSuccess: () => {
			toast.success("Vercel disconnected");
			refresh();
		},
		onError: (error) => toast.error(error.message),
	});
	const setScope = electronTrpc.vercel.setScope.useMutation({
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});

	const account = status.data?.account;

	return (
		<Card data-vercel-integration>
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-3">
						<div className="flex size-10 items-center justify-center rounded-lg border bg-muted/50">
							<SiVercel className="size-5" />
						</div>
						<div>
							<div className="flex items-center gap-2">
								<span className="font-medium">Vercel</span>
								{connected ? (
									<Badge variant="default" className="gap-1">
										<HiCheckCircle className="size-3" />
										Connected
									</Badge>
								) : (
									<Badge variant="secondary">Not Connected</Badge>
								)}
							</div>
							<CardDescription className="mt-0.5">
								Your websites, deployments and build logs, for you and your
								agents
							</CardDescription>
						</div>
					</div>
					{connected && (
						<Button
							variant="outline"
							size="sm"
							disabled={disconnect.isPending}
							onClick={() => disconnect.mutate()}
						>
							Disconnect
						</Button>
					)}
				</div>
			</CardHeader>
			<CardContent className="space-y-3 pt-0 text-sm">
				{connected && account ? (
					<>
						<p className="text-muted-foreground">
							Connected as{" "}
							<span className="font-medium text-foreground">
								{account.name || account.username}
							</span>
							. Link each team to its website with the Vercel button in the
							team's top bar.
						</p>
						{!!teams.data?.length && (
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">Projects from</span>
								<Select
									value={account.teamId ?? PERSONAL}
									onValueChange={(value) => {
										const team = teams.data?.find((t) => t.id === value);
										setScope.mutate({
											teamId: value === PERSONAL ? null : value,
											teamName: team?.name ?? team?.slug ?? null,
										});
									}}
								>
									<SelectTrigger className="h-8 w-56 text-xs">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={PERSONAL} className="text-xs">
											Personal account
										</SelectItem>
										{teams.data.map((team) => (
											<SelectItem
												key={team.id}
												value={team.id}
												className="text-xs"
											>
												{team.name || team.slug}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}
						<p className="text-xs text-muted-foreground">
							Agents can read the linked website, its deployments, build logs
							and the names of its environment variables. They cannot deploy,
							change settings or see secret values, and never see your token.
						</p>
					</>
				) : (
					<form
						className="space-y-2"
						onSubmit={(event) => {
							event.preventDefault();
							if (token.trim()) connect.mutate({ token: token.trim() });
						}}
					>
						<p className="text-muted-foreground">
							1.{" "}
							<button
								type="button"
								onClick={() => openUrl.mutate(TOKEN_PAGE)}
								className="inline-flex items-center gap-1 text-primary hover:underline"
							>
								Create a token on vercel.com
								<HiOutlineArrowTopRightOnSquare className="size-3" />
							</button>{" "}
							(any name; choose the scope with your projects). 2. Paste it here.
						</p>
						<div className="flex gap-2">
							<Input
								type="password"
								autoComplete="off"
								spellCheck={false}
								placeholder="Vercel access token"
								aria-label="Vercel access token"
								value={token}
								onChange={(event) => setToken(event.target.value)}
								className="h-8 text-xs"
							/>
							<Button
								type="submit"
								size="sm"
								disabled={!token.trim() || connect.isPending}
							>
								{connect.isPending ? "Checking…" : "Connect"}
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							ADE checks the token with Vercel, then keeps it encrypted on this
							computer. Your agents never see it.
						</p>
					</form>
				)}
			</CardContent>
		</Card>
	);
}
