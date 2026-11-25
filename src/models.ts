// Model discovery and launch configuration. No hardcoded provider/model preferences:
// the coordinator chooses using the authenticated catalogue and the task's complexity.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function resolveLaunchModel(
	spec: { model?: string; thinking?: ThinkingLevel },
	ctx: ExtensionContext,
): { model?: string; thinking?: ThinkingLevel } {
	const available = ctx.modelRegistry.getAvailable();
	const current = ctx.model;
	let selected = current;
	if (!spec.model && current && !available.some((m) => m.provider === current.provider && m.id === current.id)) {
		throw new Error(`coordinator model "${current.provider}/${current.id}" is unavailable or excluded; choose an explicit model from crew_models`);
	}
	if (spec.model) {
		const exact = available.find((m) => `${m.provider}/${m.id}` === spec.model);
		const byId = available.filter((m) => m.id === spec.model);
		selected = exact ?? byId.find((m) => m.provider === ctx.model?.provider) ?? (byId.length === 1 ? byId[0] : undefined);
		if (!selected) {
			throw new Error(`model "${spec.model}" is unavailable or ambiguous; use crew_models for an exact authenticated provider/model-id`);
		}
	}
	const requested = spec.thinking ?? ctx.thinkingLevel ?? "off";
	return {
		model: selected ? `${selected.provider}/${selected.id}` : undefined,
		// Match pi's own clamping, including non-reasoning models (always off).
		thinking: selected ? clampThinkingLevel(selected, requested) : requested,
	};
}

export function listCrewModels(ctx: ExtensionContext, options: { query?: string; offset?: number; limit?: number } = {}) {
	const terms = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	const models = ctx.modelRegistry.getAvailable()
		.filter((m) => terms.every((term) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(term)))
		.sort((a, b) => (a.cost.input + a.cost.output) - (b.cost.input + b.cost.output)
			|| `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
	const offset = options.offset ?? 0;
	const page = models.slice(offset, offset + (options.limit ?? 30));
	return {
		current: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinking: ctx.thinkingLevel,
		total: models.length,
		nextOffset: offset + page.length < models.length ? offset + page.length : undefined,
		models: page.map((m) => ({
			model: `${m.provider}/${m.id}`,
			name: m.name,
			cost: m.cost,
			contextWindow: m.contextWindow,
			thinkingLevels: getSupportedThinkingLevels(m),
		})),
	};
}
