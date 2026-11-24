import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type PreviewCandidate, PreviewView } from "./PreviewView";

const noop = () => {};
const actions = {
	onOpen: noop,
	onSelect: noop,
	onOpenInPane: noop,
	onShowDevice: noop,
};
const web = (over: Partial<PreviewCandidate> = {}): PreviewCandidate => ({
	id: "web",
	name: "Calendar",
	app: "web",
	label: "Local preview",
	status: "ready",
	url: "http://localhost:5173/",
	...over,
});

describe("Preview", () => {
	it("a running web app: opens its own address", () => {
		const html = renderToStaticMarkup(
			<PreviewView candidates={[web()]} {...actions} />,
		);
		expect(html).toContain("Open web app");
		expect(html).toContain('data-preview="ready"');
		expect(html).toContain("http://localhost:5173/");
	});

	it("a stopped web app: one click starts it, then opens it", () => {
		const html = renderToStaticMarkup(
			<PreviewView
				candidates={[web({ status: "stopped", url: undefined })]}
				{...actions}
			/>,
		);
		expect(html).toContain("Open web app");
		expect(html).toContain(">stopped<");
		expect(html).toContain("Start Calendar, wait until it answers");
	});

	it("a starting web app: waits, and cannot be clicked twice", () => {
		const html = renderToStaticMarkup(
			<PreviewView
				candidates={[web({ status: "starting", url: undefined })]}
				{...actions}
			/>,
		);
		expect(html).toContain("Starting…");
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Starting…/);
	});

	it("a desktop app: opens in its own window", () => {
		const html = renderToStaticMarkup(
			<PreviewView
				candidates={[
					web({
						id: "desk",
						name: "Calendar app",
						app: "desktop",
						label: "Opens in its own window",
						status: "stopped",
						url: undefined,
					}),
				]}
				{...actions}
			/>,
		);
		expect(html).toContain("Open desktop app: Calendar app");
		expect(html).toContain('data-preview-app="desktop"');
		expect(html).toContain("it opens in its own window");
	});

	it("a mobile app: opens on the phone", () => {
		const html = renderToStaticMarkup(
			<PreviewView
				candidates={[
					web({
						id: "phone",
						app: "mobile",
						label: "On your phone (Expo Go)",
						status: "running",
						url: undefined,
						deviceUrl: "exp://192.168.1.20:8081",
					}),
				]}
				{...actions}
			/>,
		);
		expect(html).toContain("Open on phone");
		expect(html).toContain("QR code");
	});

	it("several apps: the chosen one is shown, with a menu to choose", () => {
		const html = renderToStaticMarkup(
			<PreviewView
				candidates={[
					web(),
					web({ id: "desk", name: "Desktop", app: "desktop", url: undefined }),
				]}
				selectedId="desk"
				{...actions}
			/>,
		);
		expect(html).toContain("Open desktop app: Desktop");
		expect(html).toContain('aria-label="Choose the app to preview"');
	});

	it("nothing to preview: a disabled button that says why, or nothing at all", () => {
		const html = renderToStaticMarkup(
			<PreviewView
				candidates={[]}
				unsupportedReason="This game runs in its engine or its own window."
				{...actions}
			/>,
		);
		expect(html).toContain('data-preview="unsupported"');
		expect(html).toContain("disabled");
		expect(html).toContain("This game runs in its engine");
		expect(
			renderToStaticMarkup(<PreviewView candidates={[]} {...actions} />),
		).toBe("");
	});
});
