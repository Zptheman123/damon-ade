import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Textarea } from "@superset/ui/textarea";
import { cn } from "@superset/ui/utils";
import { useEffect, useState } from "react";
import { LuSend } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

const METHODS = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
] as const;
type Method = (typeof METHODS)[number];

interface RequestPanelProps {
	/** The running server's address, to start from. */
	baseUrl?: string;
}

function parseHeaders(text: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const at = line.indexOf(":");
		if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return headers;
}

/**
 * Send a request to a backend running on this computer and read the reply:
 * status, time, headers and body. Only local addresses are accepted.
 */
export function RequestPanel({ baseUrl }: RequestPanelProps) {
	const [method, setMethod] = useState<Method>("GET");
	const [url, setUrl] = useState(baseUrl ?? "http://localhost:3000/");
	const [headers, setHeaders] = useState("Content-Type: application/json");
	const [body, setBody] = useState("");
	const send = electronTrpc.runTargets.request.useMutation();
	useEffect(() => {
		if (baseUrl)
			setUrl((current) => (current.startsWith(baseUrl) ? current : baseUrl));
	}, [baseUrl]);
	const hasBody = method !== "GET" && method !== "HEAD";
	const res = send.data;

	return (
		<section className="space-y-2" data-request-panel>
			<h3 className="text-xs font-medium">Request</h3>
			<div className="flex gap-2">
				<Select value={method} onValueChange={(v) => setMethod(v as Method)}>
					<SelectTrigger
						className="h-8 w-[104px] font-mono text-xs"
						aria-label="Method"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{METHODS.map((m) => (
							<SelectItem key={m} value={m} className="font-mono text-xs">
								{m}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input
					aria-label="Address"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					className="h-8 font-mono text-xs"
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							send.mutate({
								method,
								url,
								headers: parseHeaders(headers),
								body: hasBody ? body : undefined,
							});
						}
					}}
				/>
				<Button
					size="sm"
					className="h-8 gap-1"
					disabled={send.isPending || !url}
					onClick={() =>
						send.mutate({
							method,
							url,
							headers: parseHeaders(headers),
							body: hasBody ? body : undefined,
						})
					}
				>
					<LuSend className="size-3.5" aria-hidden />
					Send
				</Button>
			</div>
			<Textarea
				aria-label="Headers"
				rows={2}
				value={headers}
				onChange={(e) => setHeaders(e.target.value)}
				placeholder="Header: value (one per line)"
				className="font-mono text-xs"
			/>
			{hasBody && (
				<Textarea
					aria-label="Body"
					rows={4}
					value={body}
					onChange={(e) => setBody(e.target.value)}
					placeholder='{"name": "test"}'
					className="font-mono text-xs"
				/>
			)}
			{send.error && (
				<p className="text-xs text-destructive" role="alert">
					{send.error.message}
				</p>
			)}
			{res && (
				<div className="space-y-1" data-request-response>
					<div className="flex items-center gap-2 text-xs">
						<span
							className={cn(
								"rounded px-1.5 py-0.5 font-mono font-medium",
								res.status < 300
									? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
									: res.status < 400
										? "bg-sky-500/15 text-sky-700 dark:text-sky-400"
										: "bg-destructive/15 text-destructive",
							)}
						>
							{res.status} {res.statusText}
						</span>
						<span className="text-muted-foreground">{res.ms} ms</span>
						{res.truncated && (
							<span className="text-muted-foreground">
								(body cut at 512 KB)
							</span>
						)}
					</div>
					<details className="text-[11px]">
						<summary className="cursor-pointer text-muted-foreground">
							Headers ({Object.keys(res.headers).length})
						</summary>
						<pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted/60 p-2 font-mono">
							{Object.entries(res.headers)
								.map(([k, v]) => `${k}: ${v}`)
								.join("\n")}
						</pre>
					</details>
					<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-4">
						{res.body || "(empty body)"}
					</pre>
				</div>
			)}
		</section>
	);
}
