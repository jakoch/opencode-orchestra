# Architecture

## Why detection

The advisor-mode pattern needs three models of different characters, and those
models move: tiers, subscriptions, local servers and `models.dev` all change. A
hand-written `opencode.jsonc` is correct the day it is written and silently wrong
later, so model choice is a **detection problem** — solved inside OpenCode, per
project, at load time.

## Pipeline

```text
ctx.model.list()                available models for this project
        │
        ▼
infer.buildCandidates()         filter → signals (absolute + set-relative)
        │
        ▼
roles.resolveRoles()            weighted score per role, then assignment
        │
        ├─ pins   (.opencode/orchestra.json)
        └─ options (plugin options)
        │
        ▼
ctx.agent.transform()           register builder / scout / advisor
```

### 1. Filter (`infer.isUsable`)

Only models that can drive tools survive; dead statuses are dropped. A model
without tool calling cannot be an agent.

### 2. Signals (`infer.buildCandidates`)

Two kinds, deliberately separated:

**Set-relative**, normalized across the candidates present: price, context limit,
output limit, release date. When every model is free, price carries no
information and the report says so.

**Absolute**, from names and declared metadata:

- `reasoning` — strongest declared variant, or a family keyword (`opus`, `ultra`,
  `thinking`, `gpt-5`, `step-*`), floored at 0.4 so an unbranded model is not
  punished for having no marketing name.
- `speed` — a low-latency family keyword, minus reasoning depth, plus cheapness.
- `coding` — a coding family keyword (`coder`, `sonnet`, `swe`).
- `experimental` — pre-release naming, which discounts output-bearing roles.

Every heuristic records its fired keyword in `tags`, which is what makes the
report explainable.

### 3. Scoring (`roles.score`)

Each role is a weighted sum of normalized signals; see `WEIGHTS` in
`src/roles.ts`. Speed is inverted for builder and advisor: there, faster is the
cheaper-but-worse trade. The weights are a judgement, not a fact — the place to
change when picks look wrong, and `/orchestra all` prints the score table.

### 4. Assignment (`roles.resolveRoles`)

Scoring ranks per role; assignment decides what each role gets:

1. Advisor takes its top pick first — judgment depth is the scarcest capability,
   and giving it away would let the builder and scout eat it.
2. Builder takes its best *remaining* model, so the workhorse is not the reviewer.
3. Scout takes its best remaining model.
4. Below three usable models, roles reuse one and the report says so.

Options beat the pin file, and both beat detection. An unavailable pin is
reported and ignored.

### 5. Registration (`plugin/index.ts`)

`ctx.agent.transform()` replays a callback whenever the agent registry is
rebuilt, so picks stay correct without a reload. For each role:

- if the project already defines an agent of that name, only its `model` (and
  `steps`, when configured) is set — your prompt and permissions are kept;
- otherwise the full definition is written: prompt, permissions, mode, colour,
  model, variant.

Provider availability settles after load; if the catalog is empty at first read,
the plugin retries with a backoff rather than leaving roles without a model.

### 6. Quarantine: learning from failures

Detection ranks what the catalog advertises, and the catalog can be wrong in the
direction that hurts: `exo-free` kept being picked on a gateway that rejected
every call with `Model exo-free has been deprecated`, while still listed active.

So the plugin listens to `session.hook("retry")`, which carries the model ref and
a classified error, and folds failures into a durable record:

- **terminal** (deprecated, not found, unavailable, 404/410) blocks on first
  occurrence — retrying cannot fix it;
- **soft** (rate limit, 429, quota) blocks after `SOFT_FAILURE_THRESHOLD`, since
  a busy minute is normal;
- everything else is ignored.

A block drops the ref from `resolveRoles` and re-registers the transform, so the
affected role moves immediately — no restart, no config edit. Records prune after
14 days. A pin or root `model` for a quarantined model is still honoured if it
resolves, and reported as falling back when it does not: an explicit choice
should fail loudly.

### 7. Runtime signals

Assignment decides *who runs*; three signals decide whether the run can be
trusted. All are observations, not enforcement — a plugin cannot verify
correctness, so it surfaces evidence and lets the model and user judge.

**Evidence** (`src/evidence.ts`) listens to `tool.hook("execute.after")`. Writes
open a debt; a shell command matching a verification pattern settles it. A
verification run that *fails* settles nothing, because the files are still
unchecked. Debt is capped at 200 files per session and pruned after two idle
hours.

**Repetition guard** (`src/loop-guard.ts`): three identical tool calls in a row is
grinding → 30 seconds; three consecutive tool-free turns with identical text is a
model echoing a reminder instead of acting → ten minutes, because waiting cannot
fix it. State is a djb2 digest, since only consecutive equality is compared. A
user turn clears the circuit immediately.

**Context** (`src/context.ts`) resolves each window from the catalog, not a fixed
default: a 1M model measured against a 200k assumption reads "nearly full" at 20%
usage. Usage comes from host token counts, cache reads excluded — billed
separately, they would overstate the prompt. An unseeded model reports its limit
as unknown rather than asserting a number.

All three appear in `/orchestra` under `This session` and in the `/checkpoint`
prompt, so the advisor judges observed state, not the builder's summary.

### 8. Fan-out admission

The builder prompt delegates searching to the scout, and a model will happily
launch six in one message. Each is a provider request, so on a capped tier that
reliably fails the session. The `subagent` permission gates *which* agent runs,
not how many at once.

So the count is enforced in `tool.hook("execute.before")` for `subagent`. Three
properties make that work, all verified live:

- it is genuinely awaited, so waiting inside is a slow tool;
- throwing blocks the call and hands the reason back to the model;
- concurrent launches enter concurrently, so a counter sees real concurrency.

Excess launches **wait** rather than fail: a model refused four searches tends to
drop three, while one that waits gets all four as waves. Only a launch that
cannot get a slot within `fanoutWaitMs` is refused, naming what it tried to
launch.

Slots release on tool completion, correlated by tool-call id so a double release
cannot decrement someone else's slot, and reaped by lease age if a call never
reports — a crashed child cannot wedge a session. On unload, queued waiters are
refused rather than stranded.

With a limit of 2 and four parallel launches:

```text
admitted=true waited=4     inFlight=1
admitted=true waited=4     inFlight=2
admitted=true waited=9450  inFlight=2
admitted=true waited=11164 inFlight=2
```

Four results, two waves, no refusal, never more than two concurrent requests.
With a limit of 1 the third launch is refused by name.

### 9. The session model problem

A session stores its own model selection, and it wins over an agent's `model`, so
with no `model` in config a new session starts on whatever OpenCode picks as the
catalog default — the newest model, arbitrary and possibly rate-limited.

Two ways to close the gap:

- `ctx.model.transform(editor => editor.default.set(providerID, modelID))` sets
  the registry default to the detected builder model. This is `defaultModel: true`
  and opt-in, because the plugin cannot see whether you set a `model` yourself
  and should not override it silently.
- `"model": "provider/id"` in `opencode.jsonc` does the same declaratively and
  wins over anything the plugin does.

Either way, `/orchestra` compares the session and builder models and prints the
fix when they disagree.

## Why a plugin and not a generator

A generator would produce a correct `opencode.jsonc` once, then be wrong the
first time the catalog moves, and would need its own runtime. The plugin
re-derives on every load from the catalog OpenCode already has, and degrades
gracefully: without it, pins still work.

## Repository map

Open in this order when changing something.

| File | Responsibility |
| --- | --- |
| `plugin/index.ts` | The only file that talks to the host: detection, the agent transform, hooks, commands. |
| `src/infer.ts` | Catalog → capability signals. |
| `src/roles.ts` | Signals → weighted scores, then assignment and precedence. |
| `src/quarantine.ts` | Failure classification and the blocked-model record. |
| `src/evidence.ts` | Files written since the last verification run. |
| `src/loop-guard.ts` | Repetition circuits. |
| `src/fanout.ts` | Subagent admission: concurrency slots, queueing, lease reaping. |
| `src/context.ts` | Per-model window and prompt occupancy. |
| `src/agents.ts` | Role specs: mode, colour, permissions. |
| `src/prompts.ts` | The three system prompts. |
| `src/pin.ts` | Pin file read/write. |
| `src/report.ts` | Status report rendering. |
| `src/selftest.ts` | Fixtures for every module above. |
| `src/plugin-types.ts` | Structural types for the host surface used here. |
| `src/types.ts` | Shared shapes. |
| `index.ts` | Root entry. Re-exports `plugin/index.ts` so discovery-based installs work. |

Three host facts worth knowing before trusting the docs, all verified live and
all easy to get wrong:

- `ctx.agent.transform`'s editor has no `add`. `update(id, …)` upserts, which is
  how this plugin creates agents at all.
- The `context` session hook sends **no `kind` field**, and its `messages` array
  carries **no token counts**. Filtering on `kind === "primary"` silently drops
  every event; usage has to come from `ctx.session.context()`.
- A plugin package directory is loaded by its **root entry**. A repository whose
  entry lives at `plugin/index.ts` works when configured as `"./plugin"` and is
  silently ignored when cloned into `.opencode/plugins/`. The root `index.ts`
  re-export exists for that reason, and removing it breaks every config-free
  install.

## Commands

A plugin command's `execute` receives `{ sessionID, prompt, delivery }`, where
`prompt.text` is what the user typed after the slash. Each submits a new prompt
for the session's active agent — the report for `/orchestra`, an advisor
checkpoint for `/checkpoint` — keeping the model call inside OpenCode's normal
session machinery.

`opencode run` does not dispatch slash commands; it submits them as plain text.
Use the TUI, or post to `/api/session/{id}/command`.

## Verifying changes

`/orchestra-selftest` runs the resolver against fixed catalogs and asserts the
invariants: the deepest-reasoning model reaches the advisor, a low-latency family
reaches the scout, roles get distinct models when the catalog allows, stale pins
are reported, quarantined models cannot be re-picked (directly or through a stale
pin), and empty or tool-less catalogs do not throw. It also covers the runtime
signals — a failed verification leaves the debt intact, and the evidence cap
evicts rather than clears.

The fixtures call modules directly, so they cover logic, not wiring. Both host
surprises above were found by probing a live server; a unit test cannot notice a
field that never arrives. To reproduce a catalog, copy the shape of `Model.Info`
from `ctx.model.list()` into a fixture in `src/selftest.ts` and add the assertion
you care about.

`bun run test` runs the same suite headlessly, and is what CI executes. It also
imports the plugin entry first, so a broken import anywhere in the graph fails
before a single fixture runs — something `/orchestra-selftest` cannot catch,
because by then the plugin has already loaded.
