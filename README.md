# rex-crew

A **Pi** extension for spawning and coordinating sub-agents inside **Rex** terminal panes.

- Sub-agents run in Rex panes in the same tab as the coordinator session (first split to the right, subsequent agents stacked vertically).
- Each sub-agent reports live progress: state, estimated percentage, turn count, active tool calls, and explicit milestones (`crew_report`).
- The coordinator tracks progress via a widget above the editor, Rex pane labels (`● name 40% · running`), and an optional live dashboard (`/crew-dashboard`).
- Final results are delivered back to the coordinator automatically once active agents finish, and can also be inspected on demand with `crew_read`.

## Requirements

- Pi running inside a Rex session (`REX_SESSION` and `REX_BLOCK` environment variables present)
- `rex` CLI available on `PATH`

## Installation

```sh
pi install /path/to/rex-crew
```

For temporary testing without installing:

```sh
pi -e /path/to/rex-crew/index.ts
```

## Coordinator Tools and Commands

### Tools

| Tool | Description |
|---|---|
| `crew_models` | Lists authenticated models, catalogue prices (USD / 1M tokens), context windows, and supported thinking levels (`query?`, `offset?`, `limit?`) |
| `crew_spawn` | Launches one or more sub-agents (`name`, `task`, `cwd?`, `model?`, `thinking?`, `keepOpen?`) |
| `crew_status` | Shows state, progress, and recent events for one or all agents |
| `crew_read` | Reads an agent's `result`, `events`, `screen` (live Rex pane capture), or `task` |
| `crew_send` | Sends a follow-up prompt to a live agent (`keepOpen: true`) |
| `crew_stop` | Stops an agent and closes its Rex pane |
| `crew_wait` | Blocks until specified or all active agents complete (optional; results are delivered automatically) |

### Commands

- `/crew` — displays current crew status
- `/crew-dashboard` — opens the live terminal dashboard (`dashboard.mjs`) in a Rex pane
- `/crew-clear` — clears finished agent entries from the current coordinator view

When multiple agents are spawned in parallel, their results are batched and wake the coordinator once no agents remain active.

## Per-Agent Model and Thinking Selection

The coordinator can pick a distinct `model` and `thinking` effort for each agent, even within a single `crew_spawn` call:

1. Call `crew_models` to discover exact `provider/model-id` strings, catalogue pricing, context window size, and supported thinking levels. Use `query` to filter and `limit` (default 30, max 100) / `offset` to paginate via `nextOffset`.
2. Pass `model` and `thinking` per agent. Omitting either inherits the coordinator's current setting.
3. Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, clamped to what the target model supports (`off` for non-reasoning models). Unavailable or ambiguous model IDs are rejected before opening a pane.

`crew_models` lists all authenticated models visible in Pi's registry (not only the coordinator's scoped models), sorted by `input + output` catalogue price. Zero prices may indicate subscription billing or missing catalogue pricing rather than free usage. Credentials are never exposed.

### Global model exclusions

To hide older or unwanted model families from both Pi and `rex-crew`, install the companion extension [`pi-model-exclusions`](../pi-model-exclusions/README.md):

```sh
pi install /path/to/pi-model-exclusions
```

`crew_models` automatically reflects the filtered registry, `crew_spawn` rejects excluded IDs, and inheritance is refused if the coordinator's own model is excluded.

## Sub-Agent Tool

Inside a spawned sub-agent, the extension exposes:

- `crew_report(message, percent?)` — sends a milestone update to the coordinator. Turn counts and tool activity are also published automatically.

When the sub-agent completes its turn, its final response is written as the result and its Rex pane closes automatically unless `keepOpen: true` was set.

## How It Works

Each coordinator session exchanges state with its sub-agents through files under `~/.pi/agent/rex-crew/runs/<coordinator-session>/<agent-id>/`:

```
meta.json     # Task metadata, Rex pane ID, resolved model and thinking level
status.json   # State, percent, current activity, turn/tool counts, PID, resultVersion
events.jsonl  # Chronological log of report, tool, result, and error events
task.md       # Self-contained prompt passed to the sub-agent
result.md     # Final response returned to the coordinator
```

The coordinator launches each sub-agent via `rex split ... -- env REX_CREW_DIR=<dir> pi -e index.ts @task.md` and polls status files once per second. Milestone reports appear in the transcript without triggering a turn; final results trigger a follow-up turn. Dead processes and pane startup failures are detected and reported automatically.

## Testing

With Node 22.6+ and Pi peer dependencies resolvable:

```sh
npm test
```
