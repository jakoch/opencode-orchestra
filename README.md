# opencode-orchestra

Advisor-mode multi-agent setup for [OpenCode](https://opencode.ai) V2, with the models chosen for you.

A fast model searches, a mid-tier model writes, and the strongest reasoning model stays on call as a read-only reviewer. A fourth, bound to a *different* model, exists only to argue against the plan. No model IDs are hardcoded: at load time the plugin asks OpenCode which models this project actually has, scores them per role, and binds the winners.

```text
builder  (primary, edits + shell)          ← best coding fit
  ├── scout   (subagent, read-only)        ← fastest and cheapest
  ├── advisor (subagent, read-only)        ← deepest reasoning, on call
  └── skeptic (subagent, read-only)        ← argues against building it
```

## Install

Requires OpenCode V2. No dependencies, no build step — OpenCode loads the TypeScript directly.

```sh
git clone https://github.com/jakoch/opencode-orchestra .opencode/plugins/orchestra          # this project
git clone https://github.com/jakoch/opencode-orchestra ~/.config/opencode/plugins/orchestra # every project
opencode plugin add github:jakoch/opencode-orchestra                                        # managed, global
```

Discovery looks under `.opencode/plugins/<dir>` (not `plugins/` beside a project-root `opencode.jsonc`), and a package directory loads by its **root entry** — drop the top-level `index.ts` and a clone is silently ignored. Only the config route below takes options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "builder",
  "plugins": [{ "package": "./plugin", "options": { "defaultAgent": true } }]
}
```

`defaultAgent` is unavailable elsewhere, so discovery registers `builder` without making it the default and OpenCode keeps its own `build` agent. Everything else works either way.

Start OpenCode in the project. `builder`, `scout`, `advisor` and `skeptic` appear, bound to whatever the local catalog offers. Run `/orchestra` for the assignment and why each model won.

## Commands

| Command | What it does |
| --- | --- |
| `/orchestra` | The current assignment and why each model won. |
| `/orchestra recheck` | Re-detect against the live catalog first. |
| `/orchestra all` | Same, plus the full score table, for tuning. |
| `/orchestra-pin` | Freeze the assignment into `.opencode/orchestra.json`. |
| `/checkpoint` | Advisor review of the current plan or diff before you continue. |
| `/panel <proposal>` | Skeptic and advisor review the same proposal independently — should this be built, why this way, can it be simpler. Both run in parallel, so neither sees the other's verdict. |
| `/orchestra-selftest` | Check the resolver against fixed catalogs. |

## How the roles are chosen

Each model is scored per role as a weighted sum of signals. Nothing here is a benchmark — family keywords stand in for capability, and every pick is explained so you can disagree with it.

| Signal | Source | Weighted for |
| --- | --- | --- |
| price | cheapest cost tier | scout |
| latency | family keyword (`flash`, `haiku`, `lightning`) minus reasoning depth | scout |
| reasoning | declared variants, family keyword (`opus`, `thinking`) | advisor |
| coding | family keyword (`coder`, `sonnet`, `swe`) | builder |
| context / output limit | catalog `limit` | builder, advisor |
| release date | `time.released` | tiebreaker |
| maturity | `preview` / `alpha` / `beta` in the name | discounts builder, advisor |

Precedence: plugin options, then the pin file, then detection. A stale pin or an unavailable model is reported and falls back to detection, so no role is ever left without one.

## Safety rails

Five things the plugin learns from real behaviour instead of trusting the session's own account. All advisory — nothing is blocked, because a plugin cannot decide whether code is correct.

- **Quarantine.** The catalog lies: a model withdrawn upstream can still read `active`. Provider failures are classified and remembered — terminal errors (deprecated, not found) drop a model immediately, rate limits after three.
- **Evidence.** Files written are tracked; a command that looks like verification clears them. A *failed* run clears nothing.
- **Fan-out admission.** Model choice does not bound how many scouts the builder launches, and the `subagent` permission gates only *which* agent runs. Launches past two per session queue, so a fan-out becomes waves, not a stampede.
- **Repetition guard.** Three identical tool calls opens a 30-second circuit; three identical tool-free turns opens ten minutes. One needs patience, the other needs you.
- **Context pressure.** Judged against each model's real window, counting cached tokens — resident in the window even though nearly free.

## Options

`defaultAgent`, `defaultModel`, `pin`, `roles`, `variants`, `hideAdvisor`, `steps`, `commands`, `selftest`, `quarantine`, `evidence`, `loopGuard`, `context`, `contextWarnRatio`, `contextMaxTokens`, `maxConcurrentSubagents`, `fanoutWaitMs`, `enabled` — all optional. The full table, override precedence and plain-config fallback are in [docs/configuration.md](docs/configuration.md).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/roles.md](docs/roles.md) | Role contracts, prompts, permissions, when the builder calls the advisor. |
| [docs/architecture.md](docs/architecture.md) | The detection pipeline, assignment rules, hooks, repository map. |
| [docs/configuration.md](docs/configuration.md) | Every option, install shapes, pinning, overriding, plain-config fallback. |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Rate limits, dead models, caching, wrong picks. |
| [docs/host-behavior.md](docs/host-behavior.md) | Graded inventory of host behaviors this plugin depends on, with re-check commands. |
