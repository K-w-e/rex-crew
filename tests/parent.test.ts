import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("coordinator tools discover models and pass per-agent model/effort to pi", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rex-crew-test-"));
	const saved = { ...process.env };
	t.after(() => {
		for (const key of ["PATH", "REX_CREW_ROOT", "REX_SESSION", "REX_BLOCK", "CREW_TEST_CALLS"]) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});
	process.env.REX_CREW_ROOT = path.join(dir, "runs");
	process.env.REX_SESSION = "test-session";
	process.env.REX_BLOCK = "test-block";
	process.env.CREW_TEST_CALLS = path.join(dir, "calls.jsonl");
	process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
	// Stub only the external Rex executable: no real panes or model calls are made.
	fs.writeFileSync(path.join(dir, "rex"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CREW_TEST_CALLS, JSON.stringify(args) + "\\n");
console.log(JSON.stringify(args[0] === "split" ? { block_ids: ["fake-block"] } : { blocks: [] }));
`, { mode: 0o755 });

	const { default: parent } = await import("../src/parent.ts");
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	parent({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const strong = {
		provider: "primary", id: "strong", name: "Strong", reasoning: true,
		cost: { input: 10, output: 30, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000,
	};
	const small = { ...strong, provider: "budget", id: "small", name: "Small", cost: { ...strong.cost, input: 0.1, output: 0.2 } };
	const fast = { ...small, id: "fast", reasoning: false };
	const ctx = {
		cwd: dir, hasUI: false, model: strong, thinkingLevel: "high",
		modelRegistry: { getAvailable: () => [strong, small, fast] },
		sessionManager: { getSessionId: () => "test-parent" },
	};
	await handlers.get("session_start")({}, ctx);
	t.after(() => handlers.get("session_shutdown")());
	const execute = (name: string, args: object) => tools.get(name).execute("test", args, undefined, undefined, ctx);
	const catalogue = await execute("crew_models", { query: "budget" });
	assert.equal(JSON.parse(catalogue.content[0].text).total, 2);
	assert.ok(tools.get("crew_spawn").parameters.properties.agents.items.properties.thinking.enum.includes("max"));
	assert.ok(tools.get("crew_spawn").promptGuidelines.some((s: string) => s.includes("inexpensive")));

	const result = await execute("crew_spawn", { agents: [
		{ name: "read", task: "Read files", model: "budget/small", thinking: "low" },
		{ name: "deep", task: "Analyze a bug" },
		{ name: "fast", task: "Find a filename", model: "budget/fast", thinking: "max" },
		{ name: "invalid", task: "No launch", model: "unavailable/model" },
	] });
	assert.match(result.content[0].text, /model budget\/small, thinking low/);
	assert.match(result.content[0].text, /model primary\/strong, thinking high/);
	assert.match(result.content[0].text, /model budget\/fast, thinking off/);
	assert.match(result.content[0].text, /invalid: FAILED to launch.*crew_models/);

	const calls = fs.readFileSync(process.env.CREW_TEST_CALLS, "utf8").trim().split("\n").map((s) => JSON.parse(s) as string[]);
	const launches = calls.filter((args) => args[0] === "split");
	assert.equal(launches.length, 3);
	for (const [index, [model, effort]] of [["budget/small", "low"], ["primary/strong", "high"], ["budget/fast", "off"]].entries()) {
		const args = launches[index];
		assert.equal(args[args.indexOf("--model") + 1], model);
		assert.equal(args[args.indexOf("--thinking") + 1], effort);
	}
	const runDir = path.join(process.env.REX_CREW_ROOT, "test-parent");
	assert.equal(fs.readdirSync(runDir).length, 3);
	const status = await execute("crew_status", {});
	assert.match(status.content[0].text, /model: budget\/small, thinking: low/);
});
