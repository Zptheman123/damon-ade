import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenLocalhostView, type PreviewCandidate } from "./OpenLocalhostView";

const noop = () => {};
const actions = { onOpen: noop, onSelect: noop, onOpenInPane: noop };
const web = (over: Partial<PreviewCandidate> = {}): PreviewCandidate => ({
	id: "web",
	name: "Calendar",
	label: "Local preview",
	status: "ready",
	url: "http://localhost:5173/",
	...over,
});

describe("Open localhost", () => {
	it("ready: opens the preview's own address", () => {
		const html = renderToStaticMarkup(
			<OpenLocalhostView candidates={[web()]} {...actions} />,
		);
		expect(html).toContain("Open localhost");
		expect(html).toContain('data-open-localhost="ready"');
		expect(html).toContain("http://localhost:5173/");
	});

	it("stopped: says so and offers Run and open", () => {
		const html = renderToStaticMarkup(
			<OpenLocalhostView
				candidates={[web({ status: "stopped", url: undefined })]}
				{...actions}
			/>,
		);
		expect(html).toContain("Run and open");
		expect(html).toContain(">stopped<");
		expect(html).toContain("is stopped");
	});

	it("starting: waits, and cannot be clicked twice", () => {
		const html = renderToStaticMarkup(
			<OpenLocalhostView
				candidates={[web({ status: "starting", url: undefined })]}
				{...actions}
			/>,
		);
		expect(html).toContain("Starting…");
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Starting…/);
	});

	it("several previews: the chosen one is shown, with a menu to choose", () => {
		const html = renderToStaticMarkup(
			<OpenLocalhostView
				candidates={[
					web(),
					web({
						id: "renderer",
						name: "Desktop app",
						label: "Renderer preview (not the full desktop app)",
						status: "stopped",
						url: undefined,
					}),
				]}
				selectedId="renderer"
				{...actions}
			/>,
		);
		expect(html).toContain("Run and open: Desktop app");
		expect(html).toContain('aria-label="Choose the preview to open"');
	});

	it("no browser preview: a disabled button that says why, or nothing at all", () => {
		const html = renderToStaticMarkup(
			<OpenLocalhostView
				candidates={[]}
				unsupportedReason="This game runs in its engine or its own window."
				{...actions}
			/>,
		);
		expect(html).toContain('data-open-localhost="unsupported"');
		expect(html).toContain("disabled");
		expect(html).toContain("This game runs in its engine");
		expect(
			renderToStaticMarkup(<OpenLocalhostView candidates={[]} {...actions} />),
		).toBe("");
	});
});
