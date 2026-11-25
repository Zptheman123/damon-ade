import { describe, expect, it, mock } from "bun:test";
import {
	buildTerminalCommand,
	launchCommandInPane,
	writeCommandsInPane,
} from "./launch-command";

describe("launchCommandInPane", () => {
	it("creates a terminal session and writes the command with a newline", async () => {
		const createOrAttach = mock(async () => ({}));
		const write = mock(async () => ({}));

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "echo hello",
			createOrAttach,
			write,
		});

		expect(createOrAttach).toHaveBeenCalledWith({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo hello\n",
			throwOnError: true,
		});
	});

	it("does not append a second newline when command already has one", async () => {
		const createOrAttach = mock(async () => ({}));
		const write = mock(async () => ({}));

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "echo hello\n",
			createOrAttach,
			write,
		});

		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo hello\n",
			throwOnError: true,
		});
	});
});

describe("launchCommandInPane when the session is slow to start", () => {
	it("retries until the session is up, then types the command once", async () => {
		let creates = 0;
		const createOrAttach = mock(async () => {
			creates++;
			if (creates < 3) throw new Error("Terminal session not ready");
			return {};
		});
		let writes = 0;
		const write = mock(async () => {
			writes++;
			if (writes < 2) throw new Error("not found or not alive");
			return {};
		});

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "claude",
			createOrAttach,
			write,
			retry: { attempts: 5, delayMs: 1 },
		});

		expect(createOrAttach).toHaveBeenCalledTimes(4);
		expect(write).toHaveBeenCalledTimes(2);
	});

	it("gives up with the error after the last attempt", async () => {
		const createOrAttach = mock(async () => {
			throw new Error("never starts");
		});
		const write = mock(async () => ({}));
		await expect(
			launchCommandInPane({
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				command: "claude",
				createOrAttach,
				write,
				retry: { attempts: 2, delayMs: 1 },
			}),
		).rejects.toThrow("never starts");
		expect(write).not.toHaveBeenCalled();
	});
});

describe("buildTerminalCommand", () => {
	it("joins commands with shell separators", () => {
		expect(buildTerminalCommand(["echo one", "echo two"])).toBe(
			"echo one && echo two",
		);
	});

	it("returns null for empty commands", () => {
		expect(buildTerminalCommand([])).toBeNull();
		expect(buildTerminalCommand(null)).toBeNull();
		expect(buildTerminalCommand(undefined)).toBeNull();
	});
});

describe("writeCommandsInPane", () => {
	it("writes joined command with newline", async () => {
		const write = mock(async () => ({}));

		await writeCommandsInPane({
			paneId: "pane-1",
			commands: ["echo one", "echo two"],
			write,
		});

		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo one && echo two\n",
			throwOnError: true,
		});
	});

	it("does not write when commands are empty", async () => {
		const write = mock(async () => ({}));

		await writeCommandsInPane({
			paneId: "pane-1",
			commands: [],
			write,
		});

		expect(write).not.toHaveBeenCalled();
	});
});
