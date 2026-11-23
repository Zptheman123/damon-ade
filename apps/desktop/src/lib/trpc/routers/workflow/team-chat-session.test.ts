import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptPathFor } from "main/lib/usage-metrics/transcript";
import { teamChatCommand, teamChatSession } from "./team-mcp";

/** A temporary Claude config folder and ADE home: nothing real is touched. */
const root = mkdtempSync(join(tmpdir(), "ade-teamchat-"));
const previous = process.env.CLAUDE_CONFIG_DIR;
beforeAll(() => {
	process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
});
afterAll(() => {
	if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = previous;
	rmSync(root, { recursive: true, force: true });
});

describe("the Team chat keeps its conversation", () => {
	const home = join(root, "ade");
	const cwd = join(root, "Test App");

	it("starts with a recorded id, and keeps that id until the first message", () => {
		const first = teamChatSession(home, "ws-1", cwd);
		expect(first.resume).toBeUndefined();
		expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		const again = teamChatSession(home, "ws-1", cwd);
		expect(again).toEqual({ sessionId: first.sessionId });
		const command = teamChatCommand("C:\\x\\ws-1.mcp.json", first);
		expect(command).toContain(`-n "Team chat" --session-id ${first.sessionId}`);
	});

	it("resumes that conversation once it has a transcript", () => {
		const { sessionId } = teamChatSession(home, "ws-1", cwd);
		const transcript = transcriptPathFor(cwd, sessionId as string);
		mkdirSync(join(transcript, ".."), { recursive: true });
		writeFileSync(transcript, '{"type":"user"}\n');
		const session = teamChatSession(home, "ws-1", cwd);
		expect(session).toEqual({ resume: sessionId });
		const command = teamChatCommand("C:\\x\\ws-1.mcp.json", session);
		expect(command).toContain(`claude --resume ${sessionId}`);
		expect(command).not.toContain("--session-id");
		expect(command).toContain('--mcp-config "C:/x/ws-1.mcp.json"');
	});

	it("each team workspace has its own conversation", () => {
		const a = teamChatSession(home, "ws-a", cwd);
		const b = teamChatSession(home, "ws-b", cwd);
		expect(a.sessionId).not.toBe(b.sessionId);
	});
});
