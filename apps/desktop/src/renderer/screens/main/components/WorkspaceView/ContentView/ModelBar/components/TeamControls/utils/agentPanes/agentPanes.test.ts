import { describe, expect, it } from "bun:test";
import type { Pane } from "shared/tabs-types";
import { agentPanes } from "./agentPanes";

const pane = (id: string, tabId: string, extra: Partial<Pane> = {}): Pane => ({
	id,
	tabId,
	type: "terminal",
	name: id,
	...extra,
});

describe("agentPanes", () => {
	const state = {
		tabs: [
			{ id: "t-main", name: "", workspaceId: "main", createdAt: 0 },
			{ id: "t-agent", name: "", workspaceId: "agent", createdAt: 0 },
			{ id: "t-other", name: "", workspaceId: "other-project", createdAt: 0 },
		],
		panes: {
			working: pane("working", "t-main", { status: "working" }),
			asking: pane("asking", "t-agent", { status: "permission" }),
			done: pane("done", "t-agent", { status: "review" }),
			shell: pane("shell", "t-main"),
			idle: pane("idle", "t-main", { status: "idle" }),
			browser: pane("browser", "t-main", {
				type: "webview",
				status: "working",
			}),
			elsewhere: pane("elsewhere", "t-other", { status: "working" }),
		},
	};

	it("only Claude sessions of the team, in the asked states", () => {
		expect(agentPanes(state, ["main", "agent"], ["working"])).toEqual([
			"working",
		]);
		expect(
			agentPanes(state, ["main", "agent"], ["working", "permission"]).sort(),
		).toEqual(["asking", "working"]);
	});

	it("never a plain shell, a finished session or another project's pane", () => {
		const all = agentPanes(state, ["main", "agent"], ["working", "permission"]);
		for (const id of ["shell", "idle", "done", "browser", "elsewhere"]) {
			expect(all).not.toContain(id);
		}
	});
});
