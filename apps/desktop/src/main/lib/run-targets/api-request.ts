import { isLocalUrl } from "./run-manager";

/**
 * The request tab for backends: send one HTTP request to a server running
 * on this computer and show the answer. Only loopback addresses are
 * allowed, so it can't be pointed at production or anything on the network.
 */

export interface ApiRequest {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
	url: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface ApiResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	truncated: boolean;
	ms: number;
}

const MAX_BODY = 512 * 1024;

export async function sendLocalRequest(
	req: ApiRequest,
	fetchFn: typeof fetch = fetch,
): Promise<ApiResponse> {
	if (!isLocalUrl(req.url)) {
		throw new Error(
			"Requests go only to servers on this computer (localhost, 127.0.0.1).",
		);
	}
	const started = Date.now();
	const res = await fetchFn(req.url, {
		method: req.method,
		headers: req.headers,
		body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
		redirect: "manual",
		signal: AbortSignal.timeout(30_000),
	});
	const text = req.method === "HEAD" ? "" : await res.text();
	const headers: Record<string, string> = {};
	res.headers.forEach((value, name) => {
		headers[name] = value;
	});
	let body = text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
	if ((headers["content-type"] ?? "").includes("json")) {
		try {
			body = JSON.stringify(JSON.parse(text), null, 2).slice(0, MAX_BODY);
		} catch {
			// Not valid JSON: show it as it came.
		}
	}
	return {
		status: res.status,
		statusText: res.statusText,
		headers,
		body,
		truncated: text.length > MAX_BODY,
		ms: Date.now() - started,
	};
}
