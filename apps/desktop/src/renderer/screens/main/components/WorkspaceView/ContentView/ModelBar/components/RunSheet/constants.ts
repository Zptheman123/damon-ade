/** How each project type is run and previewed, said once at the top. */
export const TYPE_HINTS: Record<string, string> = {
	website:
		"Start the dev server, then open the preview here or in your browser. Pick a screen size from the preview's ⋯ menu.",
	"web-app":
		"Start the dev server, then open the preview here or in your browser. Pick a screen size from the preview's ⋯ menu; attach a screenshot to a task from there too.",
	"mobile-app":
		"The web preview is the browser build of your app, not the native app. To try it on a phone, open the device address (exp://…) in Expo Go; Expo's QR code is in the log. Simulators and emulators need their SDKs installed.",
	"desktop-app":
		"Desktop apps open in their own window. ADE shows the log and stops the whole process tree when you press Stop.",
	game: "Games run in their engine or their own window; web games preview here. What each target needs installed is listed on it.",
	"backend-api":
		"Start the server, then send test requests below. Requests go only to servers on this computer.",
	cli: "Set the arguments and run. The output and exit code appear in the log.",
	library:
		"Run the tests or the build; results and the exit code appear in the log.",
	"data-ai":
		"Run scripts, notebooks or training jobs; output appears in the log. Notebook servers open in the preview.",
	other: "Add the commands you use. ADE runs them only when you press Start.",
};

export const KIND_LABELS: Record<string, string> = {
	web: "Web",
	service: "Server",
	mobile: "Mobile",
	desktop: "Desktop window",
	game: "Game",
	cli: "Command",
	test: "Tests",
	custom: "Custom",
};

export const STATUS: Record<
	string,
	{ label: string; dot: string; text: string }
> = {
	starting: {
		label: "Starting",
		dot: "bg-amber-500 animate-pulse",
		text: "text-amber-600 dark:text-amber-400",
	},
	ready: {
		label: "Ready",
		dot: "bg-emerald-500",
		text: "text-emerald-600 dark:text-emerald-400",
	},
	running: {
		label: "Running",
		dot: "bg-sky-500",
		text: "text-sky-600 dark:text-sky-400",
	},
	stopping: {
		label: "Stopping",
		dot: "bg-amber-500 animate-pulse",
		text: "text-amber-600 dark:text-amber-400",
	},
	exited: {
		label: "Finished",
		dot: "bg-muted-foreground/50",
		text: "text-muted-foreground",
	},
	failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive" },
	stopped: {
		label: "Stopped",
		dot: "bg-muted-foreground/50",
		text: "text-muted-foreground",
	},
	idle: {
		label: "Not running",
		dot: "bg-muted-foreground/30",
		text: "text-muted-foreground",
	},
};

export const LIVE = new Set(["starting", "ready", "running", "stopping"]);
