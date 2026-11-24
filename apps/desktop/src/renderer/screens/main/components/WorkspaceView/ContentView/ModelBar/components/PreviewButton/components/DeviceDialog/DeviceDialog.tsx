import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { LuCopy, LuGlobe } from "react-icons/lu";

interface DeviceDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	name: string;
	/** exp://… */
	deviceUrl: string;
	/** Its web build, when it serves one. */
	url?: string;
	/** The QR code the server printed, as rows of block characters. */
	qr?: string[];
	onCopy: (text: string) => void;
	onOpenWeb: (url: string) => void;
}

/** A mobile app on the user's phone: its QR code and address. */
export function DeviceDialog({
	open,
	onOpenChange,
	name,
	deviceUrl,
	url,
	qr,
	onCopy,
	onOpenWeb,
}: DeviceDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[420px]" data-device-dialog>
				<DialogHeader>
					<DialogTitle>Open {name} on your phone</DialogTitle>
					<DialogDescription>
						{qr
							? "Scan this with your phone's camera (iPhone) or the Expo Go app (Android)."
							: "Open this address in the Expo Go app on your phone."}{" "}
						Your phone must be on the same Wi-Fi as this computer.
					</DialogDescription>
				</DialogHeader>
				{qr && (
					<div className="flex justify-center rounded-md bg-black p-3">
						<pre
							className="select-none font-mono text-[9px] leading-none text-white"
							aria-label={`QR code for ${deviceUrl}`}
							role="img"
						>
							{qr.join("\n")}
						</pre>
					</div>
				)}
				<div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
					<code className="min-w-0 flex-1 truncate text-xs">{deviceUrl}</code>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 gap-1 px-2 text-xs"
						onClick={() => onCopy(deviceUrl)}
					>
						<LuCopy className="size-3" aria-hidden />
						Copy
					</Button>
				</div>
				{url && (
					<Button
						variant="outline"
						size="sm"
						className="gap-2 self-start text-xs"
						onClick={() => onOpenWeb(url)}
					>
						<LuGlobe className="size-3.5" aria-hidden />
						Open the web version instead
					</Button>
				)}
				<p className="text-xs text-muted-foreground">
					Expo Go is free on the App Store and Google Play. No QR code? It
					appears in the app's log in Run once it has started.
				</p>
			</DialogContent>
		</Dialog>
	);
}
