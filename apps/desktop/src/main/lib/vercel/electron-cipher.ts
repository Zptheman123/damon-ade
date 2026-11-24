// A namespace import: modules that load this one (the task controller's
// service) also load under the test runner, where Electron has no safeStorage.
import * as electron from "electron";
import type { Cipher } from "./connection";

/** The operating system's key store (DPAPI on Windows, Keychain on macOS). */
export function electronCipher(): Cipher {
	const store = electron.safeStorage;
	return {
		available: () => !!store?.isEncryptionAvailable(),
		encrypt: (plain) => store.encryptString(plain),
		decrypt: (data) => store.decryptString(data),
	};
}
