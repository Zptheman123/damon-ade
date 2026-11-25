interface TerminalCreateOrAttachInput {
	paneId: string;
	tabId: string;
	workspaceId: string;
}

interface TerminalWriteInput {
	paneId: string;
	data: string;
	throwOnError?: boolean;
}

interface LaunchCommandInPaneOptions {
	paneId: string;
	tabId: string;
	workspaceId: string;
	command: string;
	createOrAttach: (input: TerminalCreateOrAttachInput) => Promise<unknown>;
	write: (input: TerminalWriteInput) => Promise<unknown>;
}

function normalizeTerminalCommand(command: string): string {
	return command.endsWith("\n") ? command : `${command}\n`;
}

interface WriteCommandInPaneOptions {
	paneId: string;
	command: string;
	write: (input: TerminalWriteInput) => Promise<unknown>;
}

interface WriteCommandsInPaneOptions {
	paneId: string;
	commands: string[] | null | undefined;
	write: (input: TerminalWriteInput) => Promise<unknown>;
}

export function buildTerminalCommand(
	commands: string[] | null | undefined,
): string | null {
	if (!Array.isArray(commands) || commands.length === 0) return null;
	return commands.join(" && ");
}

export async function writeCommandInPane({
	paneId,
	command,
	write,
}: WriteCommandInPaneOptions): Promise<void> {
	await write({
		paneId,
		data: normalizeTerminalCommand(command),
		throwOnError: true,
	});
}

export async function writeCommandsInPane({
	paneId,
	commands,
	write,
}: WriteCommandsInPaneOptions): Promise<void> {
	const command = buildTerminalCommand(commands);
	if (!command) return;
	await writeCommandInPane({ paneId, command, write });
}

/**
 * How long a new session may take to start before the command is retried.
 * A session can be slow to start (another one still closing, a busy
 * machine): the command waits for it rather than being lost, which left a
 * plain shell where a tool such as the Team chat should have been running.
 */
export const LAUNCH_RETRY = { attempts: 12, delayMs: 2_500 };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launchCommandInPane({
	paneId,
	tabId,
	workspaceId,
	command,
	createOrAttach,
	write,
	retry = LAUNCH_RETRY,
}: LaunchCommandInPaneOptions & {
	retry?: { attempts: number; delayMs: number };
}): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < Math.max(1, retry.attempts); attempt++) {
		if (attempt > 0) await wait(retry.delayMs);
		try {
			await createOrAttach({ paneId, tabId, workspaceId });
		} catch (error) {
			// Not started yet: try again shortly (attaching is idempotent).
			lastError = error;
			continue;
		}
		try {
			await writeCommandInPane({ paneId, command, write });
			return;
		} catch (error) {
			// The session is not alive yet: the command was not typed.
			lastError = error;
		}
	}
	throw lastError;
}
