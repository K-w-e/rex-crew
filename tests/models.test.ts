import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listCrewModels, resolveLaunchModel } from "../src/models.ts";

function model(provider: string, id: string, input = 1, output = 2, reasoning = true): Model<Api> {
	return {
		provider, id, name: id, api: "openai-completions", baseUrl: "https://example.invalid",
		reasoning, input: ["text"], contextWindow: 128000, maxTokens: 4096,
		cost: { input, output, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

const expensive = model("primary", "strong", 10, 30);
const cheap = model("other", "small", 0.1, 0.2);
const noReasoning = model("other", "fast", 0.01, 0.02, false);
function context(available = [expensive, cheap, noReasoning], current = expensive): ExtensionContext {
	return {
		model: current,
		thinkingLevel: "high",
		modelRegistry: { getAvailable: () => available },
	} as unknown as ExtensionContext;
}

test("omitted options inherit coordinator model and thinking", () => {
	assert.deepEqual(resolveLaunchModel({}, context()), { model: "primary/strong", thinking: "high" });
});

test("an excluded coordinator model cannot be inherited by a new agent", () => {
	assert.throws(() => resolveLaunchModel({}, context([cheap], expensive)), /excluded.*crew_models/);
	assert.equal(resolveLaunchModel({ model: "other/small" }, context([cheap], expensive)).model, "other/small");
});

test("missing thinking context defaults safely to off", () => {
	const ctx = context();
	ctx.thinkingLevel = undefined;
	assert.equal(resolveLaunchModel({}, ctx).thinking, "off");
});

test("model and effort can be selected independently per agent", () => {
	assert.deepEqual(resolveLaunchModel({ model: "other/small", thinking: "low" }, context()), {
		model: "other/small", thinking: "low",
	});
	assert.deepEqual(resolveLaunchModel({ thinking: "off" }, context()), { model: "primary/strong", thinking: "off" });
	assert.deepEqual(resolveLaunchModel({ model: "other/small" }, context()), { model: "other/small", thinking: "high" });
});

test("thinking is clamped for the selected model, including inherited effort", () => {
	assert.equal(resolveLaunchModel({ model: "other/fast" }, context()).thinking, "off");
	assert.equal(resolveLaunchModel({ model: "other/fast", thinking: "max" }, context()).thinking, "off");
	assert.equal(resolveLaunchModel({ thinking: "max" }, context()).thinking, "high");
});

test("exact model IDs may contain slashes", () => {
	const nested = model("router", "vendor/small");
	assert.equal(resolveLaunchModel({ model: "router/vendor/small" }, context([nested])).model, "router/vendor/small");
	assert.equal(resolveLaunchModel({ model: "vendor/small" }, context([nested])).model, "router/vendor/small");
});

test("bare IDs prefer the current provider and reject other ambiguities", () => {
	const first = model("primary", "shared");
	const second = model("other", "shared");
	assert.equal(resolveLaunchModel({ model: "shared" }, context([first, second])).model, "primary/shared");
	assert.throws(() => resolveLaunchModel({ model: "shared" }, context([second, model("third", "shared")])), /ambiguous.*crew_models/);
});

test("unknown or unauthenticated explicit models fail even with an empty catalogue", () => {
	assert.throws(() => resolveLaunchModel({ model: "missing/nope" }, context()), /unavailable.*crew_models/);
	assert.throws(() => resolveLaunchModel({ model: "missing/nope" }, context([])), /unavailable.*crew_models/);
});

test("discovery reports exact IDs, prices and supported levels sorted by cost", () => {
	const result = listCrewModels(context());
	assert.equal(result.current, "primary/strong");
	assert.equal(result.thinking, "high");
	assert.equal(result.total, 3);
	assert.deepEqual(result.models.map((m) => m.model), ["other/fast", "other/small", "primary/strong"]);
	assert.deepEqual(result.models[0].thinkingLevels, ["off"]);
	assert.equal(result.models[1].cost.input, 0.1);
	assert.equal(result.models[1].contextWindow, 128000);
	assert.equal(result.nextOffset, undefined);
});

test("discovery filtering is case-insensitive and supports pagination", () => {
	const first = listCrewModels(context(), { query: "OTHER", limit: 1 });
	assert.equal(first.total, 2);
	assert.equal(first.nextOffset, 1);
	const second = listCrewModels(context(), { query: "other", limit: 1, offset: first.nextOffset });
	assert.equal(second.models[0].model, "other/small");
	assert.equal(second.nextOffset, undefined);
	assert.equal(listCrewModels(context(), { query: "other small" }).total, 1);
	assert.deepEqual(listCrewModels(context(), { query: "absent" }).models, []);
	assert.deepEqual(listCrewModels(context([])).models, []);
	assert.deepEqual(listCrewModels(context(), { offset: 100 }).models, []);
});
