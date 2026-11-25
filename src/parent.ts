// Coordinator mode: spawns agents in Rex panes beside this session, tracks their progress,
// shows it in a widget and delivers their results back into this conversation.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as rexCli from "./rex.ts";
import { listCrewModels, resolveLaunchModel, THINKING_LEVELS, type ThinkingLevel } from "./models.ts";
import {
	type AgentMeta,
	type AgentStatus,
	TERMINAL,
	appendEvent,
	fmtDuration,
	isAlive,
	progressBar,
	readAllEvents,
	readEventsFrom,
	readJson,
	sessionDir,
	writeJson,
} from "./store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, "..", "index.ts");
const DASHBOARD = path.resolve(HERE, "..", "dashboard.mjs");

interface Tracked {
	meta: AgentMeta;
	dir: string;
	status?: AgentStatus;
	eventsOffset: number;
	seenResultVersion: number;
	notifiedTerminal: boolean;
}

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "agent";
}

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: {} };
}

export default function parent(pi: ExtensionAPI): void {
	const agents = new Map<string, Tracked>();
	let ctxRef: ExtensionContext | undefined;
	let baseDir = "";
	let poller: NodeJS.Timeout | undefined;
	let lastWidget = "";

	// ---------- helpers ----------

	function find(ref: string): Tracked | undefined {
		return agents.get(ref) ?? [...agents.values()].find((a) => a.meta.name === ref);
	}

	function refreshStatus(a: Tracked): void {
		a.status = readJson<AgentStatus>(path.join(a.dir, "status.json")) ?? a.status;
	}

	function markFailed(a: Tracked, reason: string): void {
		const st: AgentStatus = {
			...(a.status ?? { turns: 0, toolCalls: 0, resultVersion: 0, startedAt: a.meta.createdAt, activity: "" }),
			state: "failed",
			activity: reason,
			updatedAt: Date.now(),
		};
		writeJson(path.join(a.dir, "status.json"), st);
		appendEvent(a.dir, { ts: Date.now(), kind: "error", text: reason });
		a.status = st;
	}

	function line(a: Tracked): string {
		const th = ctxRef?.ui.theme;
		const st = a.status;
		const state = st?.state ?? "starting";
		const color = state === "done" ? "success" : state === "failed" ? "error" : state === "cancelled" ? "dim" : state === "idle" ? "warning" : "accent";
		const icon = { starting: "◌", running: "●", idle: "◐", done: "✓", failed: "✗", cancelled: "⊘" }[state];
		const elapsed = fmtDuration((TERMINAL.has(state) ? (st?.updatedAt ?? Date.now()) : Date.now()) - a.meta.createdAt);
		const bar = progressBar(st?.percent, 10);
		const activity = (st?.activity ?? "").slice(0, 70);
		const raw = `${icon} ${a.meta.name.padEnd(14)} ${state.padEnd(9)} ${bar.padEnd(15)} ${elapsed.padStart(7)}  t${st?.turns ?? 0} ${activity}`;
		return th ? th.fg(color as never, raw) : raw;
	}

	function renderWidget(): void {
		if (!ctxRef?.hasUI) return;
		const list = [...agents.values()];
		if (list.length === 0) {
			if (lastWidget) ctxRef.ui.setWidget("rex-crew", undefined);
			lastWidget = "";
			return;
		}
		const active = list.filter((a) => !TERMINAL.has(a.status?.state ?? "starting")).length;
		const header = `Rex crew — ${active} active / ${list.length} total   (/crew · /crew-dashboard · /crew-clear)`;
		const lines = [ctxRef.ui.theme.fg("muted" as never, header), ...list.slice(-8).map(line)];
		const key = lines.join("\n");
		if (key === lastWidget) return;
		lastWidget = key;
		ctxRef.ui.setWidget("rex-crew", lines);
		ctxRef.ui.setStatus("rex-crew", active ? `crew: ${active} running` : undefined);
	}

	// Wake the coordinator only when no other agent is still working, so parallel
	// results are handled in a single turn. Earlier results are already in context.
	function othersActive(a: Tracked): boolean {
		return [...agents.values()].some(
			(o) => o !== a && ![...TERMINAL, "idle"].includes(o.status?.state ?? "starting"),
		);
	}

	function deliverResult(a: Tracked, version: number): void {
		a.seenResultVersion = version;
		let result = "";
		try {
			result = fs.readFileSync(path.join(a.dir, "result.md"), "utf8");
		} catch {
			result = "(result file missing)";
		}
		pi.sendMessage(
			{
				customType: "rex-crew-result",
				content: `Sub-agent "${a.meta.name}" (id ${a.meta.id}) ${a.status?.state === "idle" ? "replied (still open for follow-ups)" : "finished"}.\n\n<agent_result id="${a.meta.id}">\n${result}\n</agent_result>`,
				display: true,
				details: { id: a.meta.id, name: a.meta.name },
			},
			{ triggerTurn: !othersActive(a), deliverAs: "followUp" },
		);
	}

	function tick(): void {
		for (const a of agents.values()) refreshStatus(a);
		for (const a of agents.values()) {
			const st = a.status;

			// Progress reports published by the agent → transcript (no extra turn triggered).
			const { events, offset } = readEventsFrom(a.dir, a.eventsOffset);
			a.eventsOffset = offset;
			for (const ev of events) {
				if (ev.kind === "report") {
					const pct = ev.percent !== undefined ? ` [${Math.round(ev.percent)}%]` : "";
					pi.sendMessage(
						{ customType: "rex-crew-progress", content: `⟳ ${a.meta.name}${pct}: ${ev.text}`, display: true, details: { id: a.meta.id } },
						{ triggerTurn: false },
					);
				}
			}

			// Liveness: the pane's pi process died without reporting.
			if (st && !TERMINAL.has(st.state) && st.pid && !isAlive(st.pid)) markFailed(a, "agent process exited unexpectedly");
			if (!st && Date.now() - a.meta.createdAt > 90_000) markFailed(a, "agent never started (is the rex-crew extension installed?)");
			if (st?.state === "starting" && Date.now() - a.meta.createdAt > 30_000) void probeStartup(a);

			const cur = a.status;
			if (cur && cur.resultVersion > a.seenResultVersion) deliverResult(a, cur.resultVersion);
			else if (cur && (cur.state === "failed" || cur.state === "cancelled") && !a.notifiedTerminal) {
				pi.sendMessage(
					{
						customType: "rex-crew-result",
						content: `Sub-agent "${a.meta.name}" (id ${a.meta.id}) ${cur.state}: ${cur.activity}. Use crew_read to inspect its events/screen.`,
						display: true,
						details: { id: a.meta.id },
					},
					{ triggerTurn: !othersActive(a), deliverAs: "followUp" },
				);
			}
			if (cur && TERMINAL.has(cur.state)) a.notifiedTerminal = true;
		}
		renderWidget();
	}

	// An agent stuck in "starting" usually shows a startup error in its pane (auth, bad model…).
	const probing = new Set<string>();
	async function probeStartup(a: Tracked): Promise<void> {
		if (probing.has(a.meta.id) || !a.meta.blockId || !a.meta.rexSession) return;
		probing.add(a.meta.id);
		try {
			const screen = await rexCli.capture(a.meta.rexSession, a.meta.blockId);
			const err = screen.split("\n").find((l) => /^\s*Error:/.test(l));
			refreshStatus(a);
			if (err && a.status?.state === "starting") markFailed(a, `startup error: ${err.trim()}`);
		} catch {
			// pane gone: liveness check will handle it
		} finally {
			setTimeout(() => probing.delete(a.meta.id), 15_000).unref();
		}
	}

	function restore(): void {
		agents.clear();
		if (!fs.existsSync(baseDir)) return;
		for (const id of fs.readdirSync(baseDir)) {
			const dir = path.join(baseDir, id);
			const meta = readJson<AgentMeta>(path.join(dir, "meta.json"));
			if (!meta) continue;
			const status = readJson<AgentStatus>(path.join(dir, "status.json"));
			let size = 0;
			try {
				size = fs.statSync(path.join(dir, "events.jsonl")).size;
			} catch {}
			agents.set(id, {
				meta,
				dir,
				status,
				eventsOffset: size,
				seenResultVersion: status?.resultVersion ?? 0,
				notifiedTerminal: TERMINAL.has(status?.state ?? "starting"),
			});
		}
	}

	async function liveAnchor(): Promise<string | undefined> {
		const session = process.env.REX_SESSION as string;
		const live = [...agents.values()].filter((a) => a.meta.blockId && !TERMINAL.has(a.status?.state ?? "starting")).reverse();
		for (const a of live) if (await rexCli.blockExists(session, a.meta.blockId as string)) return a.meta.blockId;
		return undefined;
	}

	interface SpawnSpec {
		name: string;
		task: string;
		cwd?: string;
		model?: string;
		thinking?: ThinkingLevel;
		keepOpen?: boolean;
	}

	async function spawnOne(spec: SpawnSpec, ctx: ExtensionContext): Promise<Tracked> {
		const defaultCwd = ctx.cwd;
		const { model, thinking } = resolveLaunchModel(spec, ctx);
		const session = process.env.REX_SESSION as string;
		const id = `${slug(spec.name)}-${randomBytes(2).toString("hex")}`;
		const dir = path.join(baseDir, id);
		fs.mkdirSync(dir, { recursive: true });
		const cwd = spec.cwd ? path.resolve(defaultCwd, spec.cwd) : defaultCwd;
		const meta: AgentMeta = {
			id,
			name: spec.name,
			task: spec.task,
			cwd,
			model,
			thinking,
			keepOpen: spec.keepOpen ?? false,
			rexSession: session,
			createdAt: Date.now(),
		};
		const taskFile = path.join(dir, "task.md");
		fs.writeFileSync(taskFile, `# Task for sub-agent "${spec.name}"\n\n${spec.task}\n`);
		writeJson(path.join(dir, "meta.json"), meta);
		fs.writeFileSync(path.join(dir, "events.jsonl"), "");

		const cmd = ["env", `REX_CREW_DIR=${dir}`, "pi", "-e", ENTRY, "--name", `crew:${spec.name}`];
		if (model) cmd.push("--model", model);
		if (thinking) cmd.push("--thinking", thinking);
		cmd.push(`@${taskFile}`, "Carry out the task described in the attached file.");

		const anchor = await liveAnchor();
		const blockId = await rexCli.split({
			session,
			anchor: anchor ?? (process.env.REX_BLOCK as string),
			direction: anchor ? "below" : "right",
			ratio: anchor ? 50 : 45,
			label: `◌ ${spec.name}`,
			cwd,
			command: cmd,
		});
		meta.blockId = blockId;
		writeJson(path.join(dir, "meta.json"), meta);
		const tracked: Tracked = { meta, dir, eventsOffset: 0, seenResultVersion: 0, notifiedTerminal: false };
		agents.set(id, tracked);
		return tracked;
	}

	function summary(a: Tracked): string {
		const st = a.status;
		const lastEvents = readAllEvents(a.dir)
			.slice(-3)
			.map((e) => `    - ${e.kind}: ${e.text.replace(/\s+/g, " ").slice(0, 120)}`)
			.join("\n");
		return [
			`- ${a.meta.name} (id ${a.meta.id}) — ${st?.state ?? "starting"}${st?.percent !== undefined ? ` ${Math.round(st.percent)}%` : ""}, turns ${st?.turns ?? 0}, tools ${st?.toolCalls ?? 0}, ${fmtDuration(Date.now() - a.meta.createdAt)}`,
			`  model: ${a.meta.model ?? "default"}, thinking: ${a.meta.thinking ?? "default"}`,
			`  activity: ${st?.activity ?? "-"}`,
			lastEvents,
		]
			.filter(Boolean)
			.join("\n");
	}

	// ---------- lifecycle ----------

	pi.on("session_start", async (_e, ctx) => {
		ctxRef = ctx;
		baseDir = sessionDir(ctx.sessionManager.getSessionId());
		restore();
		renderWidget();
		if (poller) clearInterval(poller);
		poller = setInterval(() => {
			try {
				tick();
			} catch (err) {
				ctxRef?.ui.notify(`rex-crew: ${(err as Error).message}`, "error");
			}
		}, 1000);
		poller.unref();
	});

	pi.on("session_shutdown", async () => {
		if (poller) clearInterval(poller);
		poller = undefined;
	});

	// ---------- tools ----------

	pi.registerTool({
		name: "crew_models",
		label: "Crew Models",
		description: "List authenticated models for crew_spawn, with exact IDs, catalogue costs (USD per million tokens), context window and supported thinking levels. Sorted by input + output price; zero prices may mean unknown/subscription pricing, not free usage. Paginated (default 30, max 100).",
		promptSnippet: "Discover models, costs and thinking levels before choosing sub-agents",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Filter by provider, model ID or name (space-separated terms)" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Pagination offset (default 0)" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Models per page (default 30)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text(JSON.stringify(listCrewModels(ctx, params), null, 2));
		},
	});

	const agentSpec = Type.Object({
		name: Type.String({ description: "Short unique label, e.g. 'api-tests'" }),
		task: Type.String({ description: "Complete, self-contained instructions. The agent does NOT see this conversation." }),
		cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
		model: Type.Optional(Type.String({ description: "Choose an exact authenticated provider/model-id from crew_models for this task. Omit to inherit the coordinator's model." })),
		thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Reasoning effort for this agent. Prefer off/low for simple tasks; higher for complex reasoning. Omit to inherit the coordinator's effort. Clamped to the selected model's supported levels." })),
		keepOpen: Type.Optional(Type.Boolean({ description: "Keep the agent alive after its answer to accept crew_send follow-ups (default false)" })),
	});

	pi.registerTool({
		name: "crew_spawn",
		label: "Crew Spawn",
		description:
			"Launch one or more pi sub-agents, each in its own Rex pane beside this session (same tab). Returns immediately. Their progress is shown in the crew widget, milestone reports appear in this transcript, and each final result is delivered automatically as a new message that wakes you.",
		promptSnippet: "Launch sub-agents in Rex panes beside this session; results are delivered back automatically",
		promptGuidelines: [
			"When the user asks to use one or more agents or sub-agents, use crew_spawn (one call can launch several agents in parallel).",
			"crew_spawn tasks must be self-contained: the sub-agent does not see this conversation.",
			"Before choosing a different model for crew_spawn, use crew_models to discover authenticated model IDs, catalogue costs and supported thinking levels; do not guess model IDs.",
			"For each crew_spawn agent, choose model and thinking to suit the task: prefer an inexpensive capable model with off/low effort for simple searches, reading, summaries or mechanical edits; reserve stronger models and higher effort for complex analysis, design or debugging. Read-only tasks can still require deep reasoning. Follow any model/effort requested by the user; omitting either option inherits the coordinator's setting.",
			"After crew_spawn, do not poll with crew_status in a loop: results arrive automatically as rex-crew-result messages. End your turn or do independent work; use crew_wait only if you must block on results.",
		],
		parameters: Type.Object({ agents: Type.Array(agentSpec, { minItems: 1, maxItems: 8 }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!rexCli.inRex()) return text("crew_spawn requires running inside Rex (REX_SESSION/REX_BLOCK not set).");
			const out: string[] = [];
			for (const spec of params.agents) {
				try {
					const a = await spawnOne(spec, ctx);
					out.push(`- ${a.meta.name}: id ${a.meta.id}, block ${a.meta.blockId}, model ${a.meta.model ?? "default"}, thinking ${a.meta.thinking ?? "default"}`);
				} catch (err) {
					out.push(`- ${spec.name}: FAILED to launch — ${(err as Error).message}`);
				}
			}
			renderWidget();
			return text(`Launched in Rex panes:\n${out.join("\n")}\nResults will be delivered automatically.`);
		},
	});

	pi.registerTool({
		name: "crew_status",
		label: "Crew Status",
		description: "Show state, progress and latest events of the sub-agents launched by crew_spawn.",
		parameters: Type.Object({ id: Type.Optional(Type.String({ description: "Agent id or name; omit for all" })) }),
		async execute(_id, params) {
			const list = params.id ? [find(params.id)].filter((a): a is Tracked => Boolean(a)) : [...agents.values()];
			if (list.length === 0) return text("No crew agents.");
			for (const a of list) refreshStatus(a);
			return text(list.map(summary).join("\n"));
		},
	});

	pi.registerTool({
		name: "crew_read",
		label: "Crew Read",
		description:
			"Read a sub-agent's output: 'result' = its final report, 'events' = progress/tool log, 'screen' = live capture of its Rex pane, 'task' = the task it received.",
		parameters: Type.Object({
			id: Type.String({ description: "Agent id or name" }),
			what: Type.Optional(StringEnum(["result", "events", "screen", "task"] as const)),
			lines: Type.Optional(Type.Number({ description: "Max trailing lines (default 200)" })),
		}),
		async execute(_id, params) {
			const a = find(params.id);
			if (!a) return text(`Unknown agent: ${params.id}`);
			const max = params.lines ?? 200;
			const tail = (s: string) => s.split("\n").slice(-max).join("\n");
			switch (params.what ?? "result") {
				case "result": {
					const f = path.join(a.dir, "result.md");
					if (!fs.existsSync(f)) return text(`${a.meta.name} has no result yet (state: ${a.status?.state ?? "starting"}).`);
					a.seenResultVersion = Math.max(a.seenResultVersion, a.status?.resultVersion ?? 0);
					return text(tail(fs.readFileSync(f, "utf8")));
				}
				case "events":
					return text(tail(readAllEvents(a.dir).map((e) => `${new Date(e.ts).toISOString().slice(11, 19)} ${e.kind}: ${e.text}`).join("\n")) || "(no events)");
				case "task":
					return text(fs.readFileSync(path.join(a.dir, "task.md"), "utf8"));
				case "screen": {
					if (!a.meta.blockId || !a.meta.rexSession) return text("No Rex block recorded.");
					try {
						return text(tail(await rexCli.capture(a.meta.rexSession, a.meta.blockId)));
					} catch (err) {
						return text(`capture failed (pane probably closed): ${(err as Error).message}`);
					}
				}
			}
			return text("unsupported");
		},
	});

	pi.registerTool({
		name: "crew_send",
		label: "Crew Send",
		description: "Send a follow-up prompt to a live sub-agent (typically one spawned with keepOpen). Its next answer is delivered automatically.",
		parameters: Type.Object({ id: Type.String(), message: Type.String() }),
		async execute(_id, params) {
			const a = find(params.id);
			if (!a?.meta.blockId || !a.meta.rexSession) return text(`Unknown agent: ${params.id}`);
			refreshStatus(a);
			if (TERMINAL.has(a.status?.state ?? "starting")) return text(`${a.meta.name} is ${a.status?.state}; spawn a new agent instead.`);
			await rexCli.sendLine(a.meta.rexSession, a.meta.blockId, params.message.replace(/\s*\n\s*/g, " "));
			return text(`Sent to ${a.meta.name}.`);
		},
	});

	pi.registerTool({
		name: "crew_stop",
		label: "Crew Stop",
		description: "Stop a sub-agent and close its Rex pane.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, params) {
			const a = find(params.id);
			if (!a) return text(`Unknown agent: ${params.id}`);
			if (a.meta.blockId && a.meta.rexSession) await rexCli.close(a.meta.rexSession, a.meta.blockId);
			refreshStatus(a);
			if (!TERMINAL.has(a.status?.state ?? "starting")) {
				writeJson(path.join(a.dir, "status.json"), { ...(a.status ?? {}), state: "cancelled", activity: "stopped by coordinator", updatedAt: Date.now() });
			}
			a.notifiedTerminal = true;
			refreshStatus(a);
			renderWidget();
			return text(`Stopped ${a.meta.name}.`);
		},
	});

	pi.registerTool({
		name: "crew_wait",
		label: "Crew Wait",
		description: "Block until the given sub-agents (default: all active) finish or reply, then return their results. Prefer automatic delivery; use this only when you must wait.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String())),
			timeoutSec: Type.Optional(Type.Number({ description: "Default 600" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const targets = (params.ids?.map(find) ?? [...agents.values()].filter((a) => !TERMINAL.has(a.status?.state ?? "starting"))).filter(
				(a): a is Tracked => Boolean(a),
			);
			if (targets.length === 0) return text("Nothing to wait for.");
			const startVersions = new Map(targets.map((a) => [a.meta.id, a.seenResultVersion]));
			const deadline = Date.now() + (params.timeoutSec ?? 600) * 1000;
			const settled = (a: Tracked) =>
				TERMINAL.has(a.status?.state ?? "starting") || (a.status?.resultVersion ?? 0) > (startVersions.get(a.meta.id) ?? 0);
			while (Date.now() < deadline && !signal?.aborted) {
				for (const a of targets) refreshStatus(a);
				if (targets.every(settled)) break;
				onUpdate?.({ content: [{ type: "text", text: targets.map(line).join("\n") }], details: {} });
				await new Promise((r) => setTimeout(r, 1000));
			}
			const parts = targets.map((a) => {
				refreshStatus(a);
				const f = path.join(a.dir, "result.md");
				a.seenResultVersion = a.status?.resultVersion ?? a.seenResultVersion;
				if (a.status && TERMINAL.has(a.status.state)) a.notifiedTerminal = true;
				const res = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "(no result)";
				return `<agent_result id="${a.meta.id}" name="${a.meta.name}" state="${a.status?.state ?? "starting"}">\n${settled(a) ? res : "(still running — timed out waiting)"}\n</agent_result>`;
			});
			return text(parts.join("\n\n"));
		},
	});

	// ---------- commands ----------

	pi.registerCommand("crew", {
		description: "Show the status of the Rex crew agents",
		handler: async (_args, ctx) => {
			const list = [...agents.values()];
			for (const a of list) refreshStatus(a);
			ctx.ui.notify(list.length ? list.map(summary).join("\n") : "No crew agents.", "info");
		},
	});

	pi.registerCommand("crew-clear", {
		description: "Remove finished crew agents from the widget",
		handler: async () => {
			for (const [id, a] of agents) if (TERMINAL.has(a.status?.state ?? "starting")) {
				agents.delete(id);
				fs.rmSync(a.dir, { recursive: true, force: true });
			}
			renderWidget();
		},
	});

	pi.registerCommand("crew-dashboard", {
		description: "Open a live crew dashboard in a Rex pane below this session",
		handler: async (_args, ctx) => {
			if (!rexCli.inRex()) return ctx.ui.notify("Not running inside Rex.", "error");
			fs.mkdirSync(baseDir, { recursive: true });
			await rexCli.split({
				session: process.env.REX_SESSION as string,
				anchor: process.env.REX_BLOCK as string,
				direction: "below",
				ratio: 30,
				label: "crew dashboard",
				cwd: ctx.cwd,
				command: ["node", DASHBOARD, baseDir],
			});
		},
	});
}
