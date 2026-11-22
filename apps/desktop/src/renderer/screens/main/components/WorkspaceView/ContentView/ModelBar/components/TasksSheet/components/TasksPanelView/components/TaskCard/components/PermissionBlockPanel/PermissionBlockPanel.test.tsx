import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskActions, TaskView } from "../../../../../../types";
import { PermissionBlockPanel } from "./PermissionBlockPanel";

const actions = { busy: false, onResume: () => {} } as unknown as TaskActions;
const task = { slug: "scaffold" } as TaskView;
const op = (over: Record<string, unknown>) => ({
	tool: "Bash",
	command: "npm install",
	text: "Bash: npm install",
	approvable: true,
	approved: false,
	prefixAllowed: false,
	...over,
});
const block = (operations: ReturnType<typeof op>[]) =>
	({
		runId: "r",
		kind: "build",
		cwd: "D:/repos/calendar",
		at: "",
		operations,
	}) as unknown as NonNullable<TaskView["permissionBlock"]>;

describe("waiting for command approval", () => {
	it("shows the exact command, the folder, and an exact approval", () => {
		const html = renderToStaticMarkup(
			<PermissionBlockPanel
				task={task}
				block={block([op({})])}
				actions={actions}
			/>,
		);
		expect(html).toContain("npm install");
		expect(html).toContain("D:/repos/calendar");
		expect(html).toContain("Approve exactly this command");
		// No prefix offer unless it is safe for this command.
		expect(html).not.toContain("with extra arguments");
		// Nothing approved: Resume is off, and retrying anyway is a separate choice.
		expect(html).toMatch(
			/<button[^>]*disabled=""[^>]*>Resume: retry the build/,
		);
		expect(html).toContain("Retry without approving");
		expect(html).toContain("the Architect was not called");
	});

	it("approved commands are marked, and Resume retries", () => {
		const html = renderToStaticMarkup(
			<PermissionBlockPanel
				task={task}
				block={block([
					op({ approved: true }),
					op({
						command: "npm view electron-vite version",
						prefixAllowed: true,
					}),
				])}
				actions={actions}
			/>,
		);
		expect(html).toContain("Approved for this project");
		expect(html).toContain("with extra arguments");
		expect(html).not.toContain("Retry without approving");
		expect(html).not.toMatch(/disabled=""[^>]*>Resume/);
	});

	it("a compound command explains why it can't be approved as one", () => {
		const html = renderToStaticMarkup(
			<PermissionBlockPanel
				task={task}
				block={block([
					op({
						command: "npm install && npm run dev",
						approvable: false,
						problem: "This joins several commands.",
					}),
				])}
				actions={actions}
			/>,
		);
		expect(html).toContain("This joins several commands.");
		expect(html).not.toContain("Approve exactly this command");
	});
});
