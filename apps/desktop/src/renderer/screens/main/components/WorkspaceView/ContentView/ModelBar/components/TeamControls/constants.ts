/**
 * Typed into each working Claude session of the team by Wrap up. Plain
 * words, periods and commas only, so nothing in it means anything to a shell.
 */
export const WRAP_UP_MESSAGE =
	"Please wrap up now. Finish the step you are on and save all your work to its files. Write down where you stopped and what is left, then stop. Do not start anything new.";

/** Escape: Claude Code interrupts what it is doing. */
export const INTERRUPT = "\u001b";

/** Wait between typing the message and pressing Enter, so it is not taken as pasted. */
export const SUBMIT_DELAY_MS = 150;
