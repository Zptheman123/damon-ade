import { useSidebarStore } from "renderer/stores/sidebar-state";
import { SidebarControl } from "../../SidebarControl";
import { ContentHeader } from "./ContentHeader";
import { AgentActivityBar } from "./components/AgentActivityBar";
import { ModelBar } from "./ModelBar";
import { TabsContent } from "./TabsContent";
import { GroupStrip } from "./TabsContent/GroupStrip";

export function ContentView() {
	const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);

	return (
		<div className="h-full flex flex-col overflow-hidden">
			<ContentHeader
				trailingAction={!isSidebarOpen ? <SidebarControl /> : undefined}
			>
				<GroupStrip />
			</ContentHeader>
			<ModelBar />
			<AgentActivityBar />
			<TabsContent />
		</div>
	);
}
