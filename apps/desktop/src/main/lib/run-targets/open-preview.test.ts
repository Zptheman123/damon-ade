import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTarget } from "main/lib/project-type/config";
import { openTargetInBrowser } from "./open-preview";
import { browserPreview } from "./preview";
import { RunManager } from "./run-manager";

/**
 * "Open localhost" with the real run manager and a tiny local server on a
 * random port (never assumed to be 3000). Opening is recorded, not done:
 * no browser starts, and no model is involved anywhere.
 */

const root = mkdtempSync(join(tmpdir(), "ade-open-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const node = JSON.stringify(process.execPath);

writeFileSync(
	join(root, "server.js"),
	`const http = require("node:http");
const delay = Number(process.argv[2] || 0);
setTimeout(() => {
  const s = http.createServer((_q, r) => r.end("calendar"));
  s.listen(0, "127.0.0.1", () => console.log("  Local:   http://localhost:" + s.address().port + "/"));
}, delay);
`,
);
writeFileSync(
	join(root, "crash.js"),
	'console.error("Error: Cannot find module vite"); process.exit(1);',
);

const web = (over: Partial<RunTarget> = {}): RunTarget => ({
	id: "web",
	name: "Calendar",
	kind: "web",
	cwd: ".",
	command: `${node} server.js`,
	...over,
});

function recorder() {
	const opened: string[] = [];
	return { opened, open: async (url: string) => void opened.push(url) };
}

describe("open localhost", () => {
	it("opens a ready target at its actual address", async () => {
		const manager = new RunManager({ probeIntervalMs: 50 });
		manager.start({ workspaceId: "ws", worktree: root, target: web() });
		const r = recorder();
		const result = await openTargetInBrowser({
			manager,
			workspaceId: "ws",
			worktree: root,
			target: web(),
			start: false,
			open: r.open,
		});
		expect(result.status).toBe("opened");
		expect(r.opened).toHaveLength(1);
		expect(r.opened[0]).toMatch(/^http:\/\/localhost:\d+\/$/);
		expect(r.opened[0]).not.toContain(":3000");
		await manager.stopAll();
	}, 20_000);

	it("a stopped target: says so, or with Run and open starts it once and opens it once", async () => {
		const manager = new RunManager({ probeIntervalMs: 50 });
		const r = recorder();
		const notStarted = await openTargetInBrowser({
			manager,
			workspaceId: "ws",
			worktree: root,
			target: web({ command: `${node} server.js 300` }),
			start: false,
			open: r.open,
		});
		expect(notStarted.status).toBe("stopped");
		expect(manager.get("ws", "web")).toBeUndefined();

		// Two clicks while it starts: one server, one browser tab.
		let starts = 0;
		manager.on("event", (e) => {
			if (e.type === "state" && e.state.status === "starting") starts++;
		});
		const target = web({ command: `${node} server.js 300` });
		const [a, b] = await Promise.all([
			openTargetInBrowser({
				manager,
				workspaceId: "ws",
				worktree: root,
				target,
				start: true,
				open: r.open,
			}),
			openTargetInBrowser({
				manager,
				workspaceId: "ws",
				worktree: root,
				target,
				start: true,
				open: r.open,
			}),
		]);
		expect(a).toEqual(b);
		expect(a.status).toBe("opened");
		expect(a.status === "opened" && a.startedNow).toBe(true);
		expect(r.opened).toHaveLength(1);
		expect(starts).toBe(1);
		await manager.stopAll();
	}, 20_000);

	it("a start that fails is reported with its output, and nothing is opened", async () => {
		const manager = new RunManager({ probeIntervalMs: 50 });
		const r = recorder();
		const result = await openTargetInBrowser({
			manager,
			workspaceId: "ws",
			worktree: root,
			target: web({ id: "crash", command: `${node} crash.js` }),
			start: true,
			open: r.open,
		});
		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.message).toContain("not ready");
		expect(result.logTail.join("\n")).toContain("Cannot find module vite");
		expect(r.opened).toEqual([]);
	}, 20_000);

	it("a server that never answers is not opened", async () => {
		const manager = new RunManager({
			probeIntervalMs: 50,
			readyTimeoutMs: 400,
		});
		const r = recorder();
		const result = await openTargetInBrowser({
			manager,
			workspaceId: "ws",
			worktree: root,
			target: web({
				id: "silent",
				command: `${node} -e "setTimeout(()=>{}, 5000)"`,
				url: "http://localhost:59999",
			}),
			start: true,
			open: r.open,
		});
		expect(result.status).toBe("failed");
		expect(r.opened).toEqual([]);
		await manager.stopAll();
	}, 20_000);

	it("never opens another workspace's server", async () => {
		const manager = new RunManager({ probeIntervalMs: 50 });
		manager.start({ workspaceId: "ws-a", worktree: root, target: web() });
		const r = recorder();
		const other = await openTargetInBrowser({
			manager,
			workspaceId: "ws-b",
			worktree: root,
			target: web(),
			start: false,
			open: r.open,
		});
		expect(other.status).toBe("stopped");
		expect(r.opened).toEqual([]);
		await manager.stopAll();
	}, 20_000);

	it("native-only targets are not opened and nothing starts", async () => {
		const manager = new RunManager();
		const r = recorder();
		const result = await openTargetInBrowser({
			manager,
			workspaceId: "ws",
			worktree: root,
			target: web({ id: "godot", kind: "game", command: "godot --path ." }),
			projectType: "game",
			start: true,
			open: r.open,
		});
		expect(result.status).toBe("failed");
		expect(manager.get("ws", "godot")).toBeUndefined();
		expect(r.opened).toEqual([]);
	});
});

describe("which targets have a browser preview", () => {
	const project = (name: string, files: Record<string, string>) => {
		const dir = join(root, name);
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(join(dir, path, ".."), { recursive: true });
			writeFileSync(join(dir, path), content);
		}
		return dir;
	};
	const pkg = (deps: Record<string, string>) =>
		JSON.stringify({ devDependencies: deps });

	it("web apps and web games: yes; servers, commands and native games: no", () => {
		expect(browserPreview(web(), root, "web-app")).toEqual({
			kind: "web",
			label: "Local preview",
		});
		expect(browserPreview(web(), root, "game").kind).toBe("web");
		expect(browserPreview(web({ kind: "service" }), root).kind).toBe("none");
		expect(browserPreview(web({ kind: "cli" }), root).kind).toBe("none");
		expect(browserPreview(web({ kind: "game" }), root, "game").kind).toBe(
			"none",
		);
	});

	it("Electron: a renderer preview only when the renderer does not use the desktop bridge", () => {
		const clean = project("electron-clean", {
			"package.json": pkg({ "electron-vite": "6", electron: "40" }),
			"src/renderer/src/App.tsx":
				"export const App = () => localStorage.getItem('x');",
			"src/preload/index.ts": "import { contextBridge } from 'electron';",
		});
		expect(
			browserPreview(web({ kind: "desktop" }), clean, "desktop-app"),
		).toEqual({
			kind: "renderer",
			label: "Renderer preview (not the full desktop app)",
		});
		const bridged = project("electron-bridge", {
			"package.json": pkg({ "electron-vite": "6", electron: "40" }),
			"src/renderer/src/App.tsx": "export const v = window.api.version;",
		});
		const preview = browserPreview(
			web({ kind: "desktop" }),
			bridged,
			"desktop-app",
		);
		expect(preview.kind).toBe("none");
		expect(preview.kind === "none" && preview.reason).toContain(
			"src/renderer/src/App.tsx",
		);
		const plain = project("electron-plain", {
			"package.json": pkg({ electron: "40" }),
		});
		expect(browserPreview(web({ kind: "desktop" }), plain).kind).toBe("none");
	});

	it("mobile: a web preview only with a web build", () => {
		const withWeb = project("expo-web", {
			"package.json": pkg({
				expo: "52",
				"react-native-web": "0.19",
				"react-dom": "19",
			}),
		});
		expect(
			browserPreview(web({ kind: "mobile" }), withWeb, "mobile-app").kind,
		).toBe("web-build");
		const native = project("expo-native", {
			"package.json": pkg({ expo: "52" }),
		});
		expect(
			browserPreview(web({ kind: "mobile" }), native, "mobile-app").kind,
		).toBe("none");
	});
});
