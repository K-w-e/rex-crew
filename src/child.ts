// Child mode: runs inside a pi session spawned by the coordinator (REX_CREW_DIR is set).
// Publishes progress to status.json/events.jsonl, renames its own Rex block, writes result.md.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rename } from "./rex.ts";
import { type AgentMeta, type AgentState, type AgentStatus, appendEvent, progressBar, readJson, writeJson } from "./store.ts";

function textOf(message: unknown): string {
	const m = message as { role?: string; content?: unknown };
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content
		.filter((c: { type?: string }) => c?.type === "text")
		.map((c: { text?: string }) => c.text ?? "")
		.join("\n")
		.trim();
}

function describeTool(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const hint = a.command ?? a.path ?? a.pattern ?? a.query ?? "";
	const s = String(hint).replace(/\s+/g, " ");
	return s ? `${name}: ${s.length > 60 ? `${s.slice(0, 57)}...` : s}` : name;
}

export default function child(pi: ExtensionAPI, dir: string): void {
	const meta = readJson<AgentMeta>(path.join(dir, "meta.json"));
	const name = meta?.name ?? path.basename(dir);
	const statusFile = path.join(dir, "status.json");
	const rexSession = process.env.REX_SESSION;
	const rexBlock = process.env.REX_BLOCK;

	const status: AgentStatus = readJson<AgentStatus>(statusFile) ?? {
		state: "starting",
		activity: "starting",
		turns: 0,
		toolCalls: 0,
		resultVersion: 0,
		startedAt: Date.now(),
		updatedAt: Date.now(),
	};
	status.pid = process.pid;
	let lastAssistantText = "";
	let lastLabel = "";
	let labelTimer: NodeJS.Timeout | undefined;

	const icon: Record<AgentState, string> = { starting: "◌", running: "●", idle: "◐", done: "✓", failed: "✗", cancelled: "⊘" };

	function updateLabel(): void {
		if (!rexSession || !rexBlock) return;
		if (labelTimer) return;
		labelTimer = setTimeout(() => {
			labelTimer = undefined;
			const pct = status.percent !== undefined ? ` ${Math.round(status.percent)}%` : "";
			const label = `${icon[status.state]} ${name}${pct} · ${status.state}`;
			if (label === lastLabel) return;
			lastLabel = label;
			void rename(rexSession, rexBlock, label);
		}, 400);
	}

	function save(patch: Partial<AgentStatus>): void {
		Object.assign(status, patch, { updatedAt: Date.now() });
		writeJson(statusFile, status);
		updateLabel();
	}

	save({});

	pi.registerTool({
		name: "crew_report",
		label: "Crew Report",
		description:
			"Report progress to the coordinator session that launched you. Call it at meaningful milestones (plan made, step done, blocker found). The coordinator sees the message in its transcript and progress widget.",
		promptSnippet: "Report progress/milestones to the coordinator agent",
		promptGuidelines: [
			"Use crew_report to notify the coordinator at each meaningful milestone, with an estimated percent of completion.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "Short progress message" }),
			percent: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "Estimated completion 0-100" })),
		}),
		async execute(_id, params) {
			appendEvent(dir, { ts: Date.now(), kind: "report", text: params.message, percent: params.percent });
			save({ lastReport: params.message, percent: params.percent ?? status.percent, activity: params.message });
			return { content: [{ type: "text", text: "Reported to coordinator." }], details: {} };
		},
	});

	pi.on("before_agent_start", async (event) => {
		const extra = [
			"",
			"<crew_role>",
			`You are the sub-agent "${name}", launched by a coordinator agent running in another Rex pane.`,
			"- Work autonomously on the task you were given; do not ask the user questions unless strictly necessary.",
			"- Call crew_report at meaningful milestones with a short message and an estimated percent.",
			"- Your FINAL assistant message is delivered verbatim to the coordinator: make it a concise, self-contained report",
			"  (what you did, files changed, results, open issues).",
			"- Do not spawn further agents.",
			"</crew_role>",
		].join("\n");
		return { systemPrompt: event.systemPrompt + extra };
	});

	pi.on("agent_start", async () => {
		save({ state: "running", activity: "thinking" });
	});

	pi.on("turn_end", async () => {
		save({ turns: status.turns + 1 });
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "crew_report") return;
		const what = describeTool(event.toolName, event.args);
		appendEvent(dir, { ts: Date.now(), kind: "tool", text: what });
		save({ toolCalls: status.toolCalls + 1, activity: what });
	});

	pi.on("message_end", async (event) => {
		const msg = event.message as { role?: string };
		if (msg.role === "assistant") {
			const t = textOf(event.message);
			if (t) lastAssistantText = t;
		} else if (msg.role === "user") {
			const t = textOf(event.message);
			if (t && status.resultVersion > 0) appendEvent(dir, { ts: Date.now(), kind: "message", text: t.slice(0, 200) });
		}
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted) {
			appendEvent(dir, { ts: Date.now(), kind: "aborted", text: "Run aborted in the agent pane" });
			save({ state: "idle", activity: "aborted (waiting in pane)" });
			return;
		}
		const result = lastAssistantText || "(the agent produced no final text)";
		fs.writeFileSync(path.join(dir, "result.md"), result);
		appendEvent(dir, { ts: Date.now(), kind: "result", text: result.slice(0, 200) });
		const keepOpen = meta?.keepOpen ?? false;
		save({
			state: keepOpen ? "idle" : "done",
			percent: 100,
			activity: keepOpen ? "waiting for follow-up" : "finished",
			resultVersion: status.resultVersion + 1,
		});
		if (!keepOpen) {
			if (labelTimer) clearTimeout(labelTimer);
			if (rexSession && rexBlock) await rename(rexSession, rexBlock, `✓ ${name} · done`);
			ctx.shutdown();
		}
	});

	let tick: NodeJS.Timeout | undefined;

	pi.on("session_shutdown", async () => {
		if (tick) clearInterval(tick);
		if (labelTimer) clearTimeout(labelTimer);
		if (status.state === "running" || status.state === "starting" || status.state === "idle") {
			const keepOpen = meta?.keepOpen ?? false;
			// A keep-open agent closed by the user after delivering results counts as done.
			save({ state: keepOpen && status.resultVersion > 0 ? "done" : "cancelled", activity: "session closed" });
		}
	});

	// Make the progress visible inside the child pane too.
	pi.on("session_start", async (_e, ctx) => {
		ctx.ui.setStatus("rex-crew", `crew agent: ${name}`);
		if (tick) clearInterval(tick);
		tick = setInterval(() => {
			const pct = progressBar(status.percent, 8);
			ctx.ui.setStatus("rex-crew", `crew agent: ${name} ${pct}`);
		}, 2000);
		tick.unref();
	});
}
