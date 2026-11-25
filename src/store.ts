// Shared file-based channel between the coordinator session and the agents it spawns.
// Layout: <root>/<parentSessionId>/<agentId>/{meta.json,status.json,events.jsonl,task.md,result.md}
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentState = "starting" | "running" | "idle" | "done" | "failed" | "cancelled";

export interface AgentMeta {
	id: string;
	name: string;
	task: string;
	cwd: string;
	model?: string;
	thinking?: string;
	keepOpen: boolean;
	blockId?: string;
	rexSession?: string;
	createdAt: number;
}

export interface AgentStatus {
	state: AgentState;
	pid?: number;
	percent?: number;
	activity: string;
	lastReport?: string;
	turns: number;
	toolCalls: number;
	resultVersion: number;
	startedAt: number;
	updatedAt: number;
}

export interface AgentEvent {
	ts: number;
	kind: "report" | "tool" | "turn" | "result" | "aborted" | "error" | "message";
	text: string;
	percent?: number;
}

export const ROOT = process.env.REX_CREW_ROOT ?? path.join(os.homedir(), ".pi", "agent", "rex-crew", "runs");

export const TERMINAL: ReadonlySet<AgentState> = new Set(["done", "failed", "cancelled"]);

export function sessionDir(parentSessionId: string): string {
	return path.join(ROOT, parentSessionId);
}

export function writeJson(file: string, data: object): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
	fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function appendEvent(dir: string, ev: AgentEvent): void {
	fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(ev)}\n`);
}

/** Reads events appended after byte `offset`; returns new events and the next offset. */
export function readEventsFrom(dir: string, offset: number): { events: AgentEvent[]; offset: number } {
	const file = path.join(dir, "events.jsonl");
	let size = 0;
	try {
		size = fs.statSync(file).size;
	} catch {
		return { events: [], offset };
	}
	if (size <= offset) return { events: [], offset };
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(size - offset);
		fs.readSync(fd, buf, 0, buf.length, offset);
		const text = buf.toString("utf8");
		const lastNl = text.lastIndexOf("\n");
		if (lastNl < 0) return { events: [], offset };
		const events = text
			.slice(0, lastNl)
			.split("\n")
			.filter(Boolean)
			.flatMap((l) => {
				try {
					return [JSON.parse(l) as AgentEvent];
				} catch {
					return [];
				}
			});
		return { events, offset: offset + Buffer.byteLength(text.slice(0, lastNl + 1)) };
	} finally {
		fs.closeSync(fd);
	}
}

export function readAllEvents(dir: string): AgentEvent[] {
	return readEventsFrom(dir, 0).events;
}

export function isAlive(pid?: number): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function progressBar(percent: number | undefined, width = 10): string {
	if (percent === undefined) return "";
	const p = Math.max(0, Math.min(100, percent));
	const full = Math.round((p / 100) * width);
	return `${"█".repeat(full)}${"░".repeat(width - full)} ${String(Math.round(p)).padStart(3)}%`;
}
