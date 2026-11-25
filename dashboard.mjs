#!/usr/bin/env node
// Live dashboard for rex-crew agents. Usage: node dashboard.mjs <session-run-dir>
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: dashboard.mjs <run-dir>");
	process.exit(2);
}

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };
const ICON = { starting: "◌", running: "●", idle: "◐", done: "✓", failed: "✗", cancelled: "⊘" };
const COLOR = { starting: C.cyan, running: C.cyan, idle: C.yellow, done: C.green, failed: C.red, cancelled: C.dim };

const readJson = (f) => {
	try {
		return JSON.parse(fs.readFileSync(f, "utf8"));
	} catch {
		return undefined;
	}
};
const fmt = (ms) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
const bar = (p, w = 20) => {
	if (p === undefined) return " ".repeat(w + 5);
	const f = Math.round((Math.max(0, Math.min(100, p)) / 100) * w);
	return `${"█".repeat(f)}${"░".repeat(w - f)} ${String(Math.round(p)).padStart(3)}%`;
};
const lastEvents = (d, n) => {
	try {
		return fs.readFileSync(path.join(d, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};

function render() {
	const cols = process.stdout.columns || 100;
	const rows = process.stdout.rows || 30;
	const out = [`${C.bold}Rex crew dashboard${C.reset}  ${C.dim}${new Date().toLocaleTimeString()}  (ctrl+c to close)${C.reset}`, ""];
	const ids = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
	const agents = ids
		.map((id) => ({ id, d: path.join(dir, id), meta: readJson(path.join(dir, id, "meta.json")), st: readJson(path.join(dir, id, "status.json")) }))
		.filter((a) => a.meta)
		.sort((a, b) => a.meta.createdAt - b.meta.createdAt);
	if (agents.length === 0) out.push(`${C.dim}No agents yet.${C.reset}`);
	const perAgent = Math.max(2, Math.floor((rows - 3) / Math.max(1, agents.length)) - 2);
	for (const a of agents) {
		const state = a.st?.state ?? "starting";
		const end = ["done", "failed", "cancelled"].includes(state) ? (a.st?.updatedAt ?? Date.now()) : Date.now();
		out.push(
			`${COLOR[state]}${ICON[state]} ${C.bold}${a.meta.name}${C.reset} ${COLOR[state]}${state}${C.reset}  ${bar(a.st?.percent)}  ${fmt(end - a.meta.createdAt)}  turns ${a.st?.turns ?? 0} · tools ${a.st?.toolCalls ?? 0}`,
		);
		out.push(`  ${C.dim}${(a.st?.activity ?? "").slice(0, cols - 4)}${C.reset}`);
		for (const e of lastEvents(a.d, Math.min(perAgent, 4))) {
			const t = new Date(e.ts).toLocaleTimeString();
			out.push(`  ${C.dim}${t}${C.reset} ${e.kind === "report" ? C.yellow : C.dim}${e.kind}${C.reset} ${String(e.text).replace(/\s+/g, " ").slice(0, cols - 22)}`);
		}
		out.push("");
	}
	process.stdout.write(`\x1b[H\x1b[2J${out.slice(0, rows).join("\n")}`);
}

process.stdout.write("\x1b[?25l");
process.on("SIGINT", () => {
	process.stdout.write("\x1b[?25h\n");
	process.exit(0);
});
render();
setInterval(render, 1000);
