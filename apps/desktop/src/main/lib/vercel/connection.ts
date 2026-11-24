import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The user's Vercel connection: an access token they created on vercel.com,
 * encrypted with the operating system's key store (Electron safeStorage:
 * DPAPI on Windows, Keychain on macOS) in ADE's home folder, plus who it
 * belongs to and which scope (personal account or a team) ADE works in.
 * Only ADE's main process reads it; models never see the token.
 */

export interface Cipher {
	available(): boolean;
	encrypt(plain: string): Buffer;
	decrypt(data: Buffer): string;
}

export interface VercelAccount {
	username: string;
	name?: string | null;
	/** The team ADE works in; null: the personal account. */
	teamId: string | null;
	teamName?: string | null;
	connectedAt: string;
}

const DIR = "vercel";
const TOKEN = "token.bin";
const ACCOUNT = "account.json";

function dirOf(homeDir: string) {
	return join(homeDir, DIR);
}

function writePrivate(path: string, data: string | Buffer) {
	writeFileSync(path, data, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort (no-op on Windows, where the profile folder is private).
	}
}

export function saveVercelConnection(
	homeDir: string,
	cipher: Cipher,
	token: string,
	account: VercelAccount,
): void {
	if (!cipher.available()) {
		throw new Error(
			"This computer has no secure key store for ADE to keep the token in, so it was not saved.",
		);
	}
	const dir = dirOf(homeDir);
	mkdirSync(dir, { recursive: true });
	writePrivate(join(dir, TOKEN), cipher.encrypt(token));
	writePrivate(join(dir, ACCOUNT), `${JSON.stringify(account, null, 2)}\n`);
}

export function loadVercelAccount(homeDir: string): VercelAccount | null {
	try {
		const raw = JSON.parse(
			readFileSync(join(dirOf(homeDir), ACCOUNT), "utf8"),
		) as VercelAccount;
		return typeof raw.username === "string"
			? { ...raw, teamId: raw.teamId ?? null }
			: null;
	} catch {
		return null;
	}
}

export function updateVercelAccount(
	homeDir: string,
	change: Partial<VercelAccount>,
): VercelAccount {
	const current = loadVercelAccount(homeDir);
	if (!current) throw new Error("Vercel is not connected.");
	const next = { ...current, ...change };
	writePrivate(
		join(dirOf(homeDir), ACCOUNT),
		`${JSON.stringify(next, null, 2)}\n`,
	);
	return next;
}

/** The token, or null when not connected (or it can no longer be read). */
export function loadVercelToken(
	homeDir: string,
	cipher: Cipher,
): string | null {
	try {
		if (!cipher.available()) return null;
		const token = cipher.decrypt(readFileSync(join(dirOf(homeDir), TOKEN)));
		return token.trim() || null;
	} catch {
		return null;
	}
}

export function clearVercelConnection(homeDir: string): void {
	rmSync(join(dirOf(homeDir), TOKEN), { force: true });
	rmSync(join(dirOf(homeDir), ACCOUNT), { force: true });
}
