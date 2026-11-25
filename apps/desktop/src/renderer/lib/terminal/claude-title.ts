/**
 * Whether a terminal's title says Claude Code is running in it. Claude Code
 * sets the title to "claude", or to its session's name behind a status
 * glyph ("✳ Team chat", a spinner frame while it works). A shell sets its
 * own name or folder ("C:\Program Files\Git\bin\bash.exe", "MINGW64:/d/x"),
 * and a new tab is "Terminal": neither counts, so text is never typed into
 * a plain shell and a running conversation is never taken for an exited one.
 */
export function isClaudeTitle(title: string | undefined): boolean {
	if (!title) return false;
	return /claude/i.test(title) || /^[^\p{L}\p{N}\s\\/~:.]\s+\S/u.test(title);
}
