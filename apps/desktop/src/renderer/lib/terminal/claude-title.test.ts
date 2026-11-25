import { describe, expect, it } from "bun:test";
import { isClaudeTitle } from "./claude-title";

describe("isClaudeTitle", () => {
	it("recognises Claude Code's titles, named sessions included", () => {
		expect(isClaudeTitle("claude")).toBe(true);
		expect(isClaudeTitle("✳ Team chat")).toBe(true);
		expect(isClaudeTitle("⠐ Team chat")).toBe(true);
		expect(isClaudeTitle("✶ Planning the storage work")).toBe(true);
	});

	it("never takes a shell or a new tab for Claude Code", () => {
		expect(isClaudeTitle("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(false);
		expect(isClaudeTitle("MINGW64:/d/Tasqer/tasqer")).toBe(false);
		expect(isClaudeTitle("Windows PowerShell")).toBe(false);
		expect(isClaudeTitle("zane@mac: ~/code")).toBe(false);
		expect(isClaudeTitle("~/code")).toBe(false);
		expect(isClaudeTitle("Terminal")).toBe(false);
		expect(isClaudeTitle("Team chat")).toBe(false);
		expect(isClaudeTitle("")).toBe(false);
		expect(isClaudeTitle(undefined)).toBe(false);
	});
});
