import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentActivityView, ago, duration } from "./AgentActivityView";

const now = Date.parse("2026-11-22T20:00:00Z");
const noop = () => {};

describe("an agent's activity", () => {
	it("working: the task, step, model, time, cost and what it is saying", () => {
		const html = renderToStaticMarkup(
			<AgentActivityView
				current={{
					title: "Visual redesign and motion system",
					kind: "build",
					role: "Implementer",
					model: "claude-sonnet-5-5",
					startedAt: "2026-11-22T19:56:48Z",
					costUsd: 0.42,
					lastText: "Adding the event colour tokens   to tokens.css",
					responses: 12,
				}}
				waiting={[]}
				queued={1}
				recent={[]}
				now={now}
				onOpenTasks={noop}
			/>,
		);
		expect(html).toContain("Building");
		expect(html).toContain("Visual redesign and motion system");
		expect(html).toContain("Implementer · Sonnet · 3m 12s · $0.42");
		expect(html).toContain("“Adding the event colour tokens to tokens.css”");
		expect(html).toContain("1 queued");
	});

	it("waiting: says so first, with the reason and a way to the task", () => {
		const html = renderToStaticMarkup(
			<AgentActivityView
				current={null}
				waiting={[
					{
						slug: "a",
						title: "Design system and app shell",
						state: "needs-input",
						reason: "The plan needs your decision: tabs or a sidebar?",
					},
				]}
				queued={0}
				recent={[]}
				now={now}
				onOpenTasks={noop}
			/>,
		);
		expect(html).toContain("Waiting for you");
		expect(html).toContain("tabs or a sidebar?");
		expect(html).toContain("Open Tasks");
	});

	it("idle: what it did last and when; nothing at all for a workspace without tasks", () => {
		const html = renderToStaticMarkup(
			<AgentActivityView
				current={null}
				waiting={[]}
				queued={0}
				recent={[
					{
						slug: "b",
						title: "Calendar views and event editor",
						state: "done",
						reason: "Verified.",
						at: "2026-11-22T18:00:00Z",
						costUsd: 5.07,
					},
				]}
				now={now}
				onOpenTasks={noop}
			/>,
		);
		expect(html).toContain("Idle");
		expect(html).toContain(
			"Last: Calendar views and event editor — finished 2 h ago",
		);
		expect(
			renderToStaticMarkup(
				<AgentActivityView
					current={null}
					waiting={[]}
					queued={0}
					recent={[]}
					now={now}
					onOpenTasks={noop}
				/>,
			),
		).toBe("");
	});

	it("formats time plainly", () => {
		expect(duration(45_000)).toBe("45s");
		expect(duration(192_000)).toBe("3m 12s");
		expect(duration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
		expect(ago("2026-11-22T19:59:30Z", now)).toBe("just now");
		expect(ago("2026-11-21T20:00:00Z", now)).toBe("1 d ago");
	});
});
