// rex-crew: multi-agent orchestration for pi inside Rex.
// - Coordinator mode (default): crew_* tools spawn sub-agents in Rex panes beside this session.
// - Agent mode (REX_CREW_DIR set): the spawned session reports progress and its result back.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import child from "./src/child.ts";
import parent from "./src/parent.ts";

const FLAG = "__rexCrewLoaded";

export default function rexCrew(pi: ExtensionAPI): void {
	// Guard against double loading (global install + explicit -e in spawned agents).
	const g = globalThis as Record<string, unknown>;
	if (g[FLAG]) return;
	g[FLAG] = true;
	pi.on("session_shutdown", async (e) => {
		if (e.reason === "quit") return;
		g[FLAG] = false; // allow re-registration on /reload, /new, /resume
	});

	const dir = process.env.REX_CREW_DIR;
	if (dir) child(pi, dir);
	else parent(pi);
}
