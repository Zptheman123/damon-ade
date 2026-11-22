import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunView, TargetView } from "../../types";
import { RunTargetCard } from "./RunTargetCard";

const noop = () => {};
const actions = {
	onStart: noop,
	onStop: noop,
	onRestart: noop,
	onOpenPreview: noop,
	onOpenExternal: noop,
	onToggleLogs: noop,
	onEdit: noop,
	onRemove: noop,
	onSaveArgs: noop,
	onCopy: noop,
};
const web: TargetView = {
	id: "web",
	name: "Web app",
	kind: "web",
	cwd: "apps/web",
	command: "bun run dev",
};
const run = (over: Partial<RunView>): RunView => ({
	status: "ready",
	startedAt: new Date().toISOString(),
	command: "bun run dev",
	...over,
});

describe("a run target", () => {
	it("not running: offers Start, and runs nothing by itself", () => {
		const html = renderToStaticMarkup(
			<RunTargetCard target={web} run={null} projectType="web-app" {...actions} />,
		);
		expect(html).toContain("Start");
		expect(html).toContain('data-run-status="idle"');
		expect(html).toContain("in apps/web");
		expect(html).not.toContain("Open preview");
	});

	it("a ready dev server: its address, preview, browser, stop and restart", () => {
		const html = renderToStaticMarkup(
			<RunTargetCard
				target={web}
				run={run({ url: "http://localhost:5173/" })}
				projectType="web-app"
				{...actions}
			/>,
		);
		expect(html).toContain("Ready");
		expect(html).toContain("http://localhost:5173/");
		expect(html).toContain("Open preview");
		expect(html).toContain("Browser");
		expect(html).toContain("Stop");
		expect(html).toContain('aria-label="Restart Web app"');
	});

	it("in a mobile project the web preview is labeled as the web build, with the device address", () => {
		const html = renderToStaticMarkup(
			<RunTargetCard
				target={{ ...web, name: "Expo" }}
				run={run({
					url: "http://localhost:8081",
					deviceUrl: "exp://192.168.1.20:8081",
				})}
				projectType="mobile-app"
				{...actions}
			/>,
		);
		expect(html).toContain("Web build (not the native app)");
		expect(html).toContain("exp://192.168.1.20:8081");
	});

	it("a command-line tool has arguments and shows its exit code", () => {
		const html = renderToStaticMarkup(
			<RunTargetCard
				target={{ ...web, kind: "cli", name: "CLI", args: "--help" }}
				run={run({ status: "failed", exitCode: 2, error: "Exited with code 2." })}
				projectType="cli"
				{...actions}
			/>,
		);
		expect(html).toContain("Arguments");
		expect(html).toContain('value="--help"');
		expect(html).toContain("exit 2");
		expect(html).toContain("Exited with code 2.");
		expect(html).toContain("Run again");
	});

	it("a server exposed to the network although LAN is off says so", () => {
		const html = renderToStaticMarkup(
			<RunTargetCard
				target={web}
				run={run({ exposedWarning: "The server says it is reachable from your network" })}
				projectType="web-app"
				{...actions}
			/>,
		);
		expect(html).toContain("reachable from your network");
	});

	it("needs and logs are shown", () => {
		const html = renderToStaticMarkup(
			<RunTargetCard
				target={{ ...web, kind: "game", prerequisite: "Godot 4 on PATH" }}
				run={run({ status: "running" })}
				projectType="game"
				logs={["Godot Engine v4.3", "Loading scene"]}
				{...actions}
			/>,
		);
		expect(html).toContain("Needs: Godot 4 on PATH");
		expect(html).toContain("Loading scene");
		expect(html).toContain("Hide log");
	});
});
