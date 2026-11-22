import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTarget } from "main/lib/project-type/config";
import { sendLocalRequest } from "./api-request";
import {
	isLocalUrl,
	type RunEvent,
	RunManager,
	targetCwd,
	urlsIn,
} from "./run-manager";

const root = mkdtempSync(join(tmpdir(), "ade-run-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A tiny dev server: listens on a free port and prints its address.
mkdirSync(join(root, "web"), { recursive: true });
writeFileSync(
	join(root, "web", "server.js"),
	`const http = require("node:http");
const s = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ path: req.url, method: req.method }));
});
s.listen(0, "127.0.0.1", () => console.log("  ➜  Local:   http://localhost:" + s.address().port + "/"));
`,
);
writeFileSync(
	join(root, "cli.js"),
	'console.log(process.argv.slice(2).join(","));',
);
const node = JSON.stringify(process.execPath);

const target = (over: Partial<RunTarget>): RunTarget => ({
	id: "web",
	name: "Web",
	kind: "web",
	cwd: "web",
	command: `${node} server.js`,
	...over,
});

function until(
	manager: RunManager,
	test: (event: RunEvent) => boolean,
	ms = 20_000,
): Promise<RunEvent> {
	return new Promise((done, fail) => {
		const timer = setTimeout(() => fail(new Error("timed out")), ms);
		const handler = (event: RunEvent) => {
			if (test(event)) {
				clearTimeout(timer);
				manager.off("event", handler);
				done(event);
			}
		};
		manager.on("event", handler);
	});
}

describe("run targets", () => {
	it("finds addresses in output, and flags network exposure", () => {
		expect(urlsIn("  ➜  Local:   http://localhost:5173/").local).toEqual([
			"http://localhost:5173/",
		]);
		const all = urlsIn(
			"ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000",
		);
		expect(all.local).toEqual(["http://localhost:3000"]);
		expect(all.exposed).toEqual(["http://0.0.0.0:3000"]);
		expect(urlsIn("Network: http://192.168.1.20:5173/").exposed.length).toBe(1);
	});

	it("only local addresses can be previewed or requested", () => {
		expect(isLocalUrl("http://localhost:3000")).toBe(true);
		expect(isLocalUrl("http://127.0.0.1:8080/api")).toBe(true);
		expect(isLocalUrl("https://api.example.com")).toBe(false);
		expect(isLocalUrl("http://192.168.1.5:3000")).toBe(false);
		expect(isLocalUrl("file:///etc/passwd")).toBe(false);
	});

	it("a target's folder must stay inside the workspace", () => {
		expect(targetCwd(root, "web")).toBe(join(root, "web"));
		expect(() => targetCwd(root, "../elsewhere")).toThrow("outside");
	});

	it("starts a dev server, sees it answer, never starts it twice, and stops its process", async () => {
		const manager = new RunManager({ probeIntervalMs: 100 });
		const ready = until(
			manager,
			(e) => e.type === "state" && e.state.status === "ready",
		);
		const first = manager.start({
			workspaceId: "ws",
			worktree: root,
			target: target({}),
		});
		expect(first.status).toBe("starting");
		const { state } = await ready;
		expect(state.url).toMatch(/^http:\/\/localhost:\d+\/$/);
		expect(manager.logs("ws", "web").some((l) => l.includes("Local:"))).toBe(
			true,
		);

		// No duplicate: the same process comes back.
		const again = manager.start({
			workspaceId: "ws",
			worktree: root,
			target: target({}),
		});
		expect(again.pid).toBe(state.pid);

		// The request tab reaches it (and only local servers).
		const res = await sendLocalRequest({
			method: "POST",
			url: `${state.url}items`,
			body: "{}",
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ path: "/items", method: "POST" });
		await expect(
			sendLocalRequest({ method: "GET", url: "https://example.com" }),
		).rejects.toThrow("this computer");

		const stopped = until(
			manager,
			(e) => e.type === "state" && e.state.status === "stopped",
		);
		await manager.stop("ws", "web");
		await stopped;
		expect(manager.get("ws", "web")?.status).toBe("stopped");
	}, 30_000);

	it("a command that fails says so, with its exit code", async () => {
		const manager = new RunManager();
		const done = until(
			manager,
			(e) => e.type === "state" && e.state.status === "failed",
		);
		manager.start({
			workspaceId: "ws",
			worktree: root,
			target: target({
				id: "bad",
				kind: "cli",
				cwd: ".",
				command: `${node} -e "process.exit(3)"`,
			}),
		});
		const { state } = await done;
		expect(state.exitCode).toBe(3);
		expect(state.error).toContain("code 3");
	}, 20_000);

	it("a command-line tool runs with its arguments and exits cleanly", async () => {
		const manager = new RunManager();
		const done = until(
			manager,
			(e) => e.type === "state" && e.state.status === "exited",
		);
		manager.start({
			workspaceId: "ws",
			worktree: root,
			target: target({
				id: "cli",
				kind: "cli",
				cwd: ".",
				command: `${node} cli.js`,
				args: "--name ADE",
			}),
		});
		const { state } = await done;
		expect(state.exitCode).toBe(0);
		expect(manager.logs("ws", "cli")).toContain("--name,ADE");
	}, 20_000);
});
