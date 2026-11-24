import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VercelSitePanel } from "./VercelSitePanel";

const noop = () => {};
const base = {
	search: "",
	onSearch: noop,
	onConnect: noop,
	onLink: noop,
	onUnlink: noop,
	onOpen: noop,
	onOpenInPane: noop,
};
const project = {
	id: "prj_cal",
	name: "calendar-site",
	productionUrl: "https://calendar.example.com",
	repo: "zane/calendar",
};

describe("VercelSitePanel", () => {
	it("not connected: sends the user to Settings", () => {
		const html = renderToStaticMarkup(
			<VercelSitePanel {...base} connected={false} />,
		);
		expect(html).toContain('data-vercel-panel="disconnected"');
		expect(html).toContain("Connect Vercel in Settings");
	});

	it("not linked: offers the likely project first, then the others", () => {
		const html = renderToStaticMarkup(
			<VercelSitePanel
				{...base}
				connected
				suggestion={{ project, because: "it deploys zane/calendar" }}
				projects={[
					project,
					{
						id: "prj_blog",
						name: "blog",
						productionUrl: "https://blog.vercel.app",
					},
				]}
			/>,
		);
		expect(html).toContain('data-vercel-panel="unlinked"');
		expect(html).toContain("Likely: it deploys zane/calendar");
		expect(html).toContain("blog");
		// The suggested project is not listed twice.
		expect(html.split("calendar-site").length - 1).toBe(1);
	});

	it("linked: the live address and the latest deployments", () => {
		const html = renderToStaticMarkup(
			<VercelSitePanel
				{...base}
				connected
				linkedName="calendar-site"
				project={project}
				deployments={[
					{
						id: "dpl_1",
						url: "https://calendar-abc.vercel.app",
						state: "ERROR",
						target: "production",
						createdAt: Date.now() - 120_000,
						branch: "main",
						commitMessage: "Add events\n\nlong body",
					},
				]}
			/>,
		);
		expect(html).toContain('data-vercel-panel="linked"');
		expect(html).toContain("calendar.example.com");
		expect(html).toContain("Failed");
		expect(html).toContain("Add events");
		expect(html).not.toContain("long body");
		expect(html).toContain("Unlink");
	});
});
