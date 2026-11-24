import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTarget } from "main/lib/project-type/config";
import { launchPreview } from "./launch-preview";
import { RunManager } from "./run-manager";

/**
 * The Preview button with the real run manager and tiny node scripts in
 * place of an app: nothing opens, no model is involved.
 */

const root = mkdtempSync(join(tmpdir(), "ade-launch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const node = JSON.stringify(process.execPath);

writeFileSync(
	join(root, "window.js"),
	'console.log("app window open"); setInterval(() => {}, 1000);',
);
writeFileSync(
	join(root, "crash.js"),
	'console.error("Error: Cannot find module electron"); process.exit(1);',
);
writeFileSync(
	join(root, "expo.js"),
	`setTimeout(() => console.log("› Metro waiting on exp://192.168.1.20:8081"), 200);
setInterval(() => {}, 1000);`,
);

const target = (over: Partial<RunTarget>): RunTarget => ({
	id: "t",
	name: "Calendar",
	kind: "desktop",
	cwd: ".",
	command: `${node} window.js`,
	...over,
});

function recorder() {
	const opened: string[] = [];
	return { opened, open: async (url: string) => void opened.push(url) };
}

describe("Preview", () => {
	it("starts a desktop app in its own window, and opens no browser", async () => {
		const manager = new RunManager({ probeIntervalMs: 50 });
		const r = recorder();
		const result = await launchPreview({
			manager,
			workspaceId: "ws",
			worktree: root,
			target: target({}),
			start: true,
			open: r.open,
			settleMs: 500,
		});
		expect(result.status).toBe("launched");
		expect(r.opened).toHaveLength(0);
		expect(manager.get("ws", "t")?.status).toBe("running");

		// A second click while it runs does not start a second app.
		const again = await launchPreview({
			manager,
			workspaceId: "ws",
			worktree: root,
			target: target({}),
			start: true,
			open: r.open,
		});
		expect(again).toMatchObject({ status: "launched", startedNow: false });
		await manager.stopAll();
	}, 20_000);

	it("a desktop app that crashes on start reports it with its log", async () => {
		const manager = new RunManager({ probeIntervalMs: 50 });
		const result = await launchPreview({
			manager,
			workspaceId: "ws",
			worktree: root,
			target: target({ command: `${node} crash.js` }),
			start: true,
			open: recorder().open,
			settleMs: 5000,
		});
		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.logTail.join("\n")).toContain("Cannot find module");
	}, 20_000);

	it("a mobile app returns its device address for a phone", async () => {
		const manager = new RunManager({ probeIntervalMs: 50 });
		const r = recorder();
		const result = await launchPreview({
			manager,
			workspaceId: "ws",
			worktree: root,
			target: target({ kind: "mobile", command: `${node} expo.js` }),
			start: true,
			open: r.open,
			deviceTimeoutMs: 10_000,
		});
		expect(result).toMatchObject({
			status: "device",
			deviceUrl: "exp://192.168.1.20:8081",
			startedNow: true,
		});
		expect(r.opened).toHaveLength(0);
		await manager.stopAll();
	}, 20_000);

	it("does not start anything unless asked", async () => {
		const manager = new RunManager({ probeIntervalMs: 50 });
		const result = await launchPreview({
			manager,
			workspaceId: "ws",
			worktree: root,
			target: target({}),
			start: false,
			open: recorder().open,
		});
		expect(result.status).toBe("stopped");
		expect(manager.get("ws", "t")).toBeUndefined();
	});
});
