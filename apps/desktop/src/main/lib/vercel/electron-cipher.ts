import { safeStorage } from "electron";
import type { Cipher } from "./connection";

/** The operating system's key store (DPAPI on Windows, Keychain on macOS). */
export function electronCipher(): Cipher {
	return {
		available: () => safeStorage.isEncryptionAvailable(),
		encrypt: (plain) => safeStorage.encryptString(plain),
		decrypt: (data) => safeStorage.decryptString(data),
	};
}
