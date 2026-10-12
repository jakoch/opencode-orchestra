# Host behavior inventory

What OpenCode v2 does that this plugin depends on, with proof. This is the
first place to look when the plugin misbehaves after a host upgrade, and the
first place to update when a new host dependence is added.

Scope: pinned `@opencode/*@2.0.26` types plus behavior observed on the running
host (2.0.27). Anything here that stops being true is a potential regression —
re-verify it (commands at the bottom) rather than trusting it.

## The grading rule

Four grades, no synonyms, and only one of them may use the word "verified":

- `live` — observed on a named host version by a listed command, with a date.
- `type` — provable from the installed `@opencode/*` types, file:line cited.
  Durable across minor bumps; **breaks loudly** when the SDK moves.
- `inferred` — believed, not proven; must say what it rests on.
- `stale` — believed once, now contradicted or unverifiable; carries the date
  it died.

Two mechanical rules. A code comment may not use the word "verified" bare — it
writes `[host-NN]` and the table below carries the proof, which is what makes
drift visible in a diff. And every row names a `file:line` that must still
exist, so a fact whose consumer is deleted becomes an **orphan**, which is the
signal to re-verify or drop it. `tests/host-facts-doc.test.ts` enforces both.

## Facts we depend on

| ID | Claim | Used at | Grade | Checked on | How to re-check |
|----|-------|---------|-------|------------|-----------------|
| H1 | Tool registration is silently selective: a name colliding with a host tool id is dropped; so is any definition carrying `options` or a declared `output`. Unique bare names with a plain-object input register, in sessions and the codemode catalog alike. `ctx.tool.list()` during setup reads pre-transform state and never shows plugin tools. | `plugin/index.ts` tool transform | live | 2026-10-13, 2.0.27, private servers + live catalogs | temp `add` + catalog read; see log below |
| H2 | The `context` session hook carries no `kind`. `kind: SessionRequestKind` exists only on the model/http/ws request hooks. Filtering context events on `kind` discards every event. | `src/plugin-types.ts:179`, context handler in `plugin/index.ts` | type + live | SDK 2.0.26 types; live 2026-10-10 | `tsc`; fire one context hook |
| H3 | The `compaction` session hook exists. Its event is a full `SessionContext` (session, agent, model, system, transcript, tools), not just a session id. | `src/plugin-types.ts:141`, compaction hook in `plugin/index.ts` | type | SDK 2.0.26, node_modules `@opencode/plugin` promise session types (`SessionHooks`, `SessionCompaction`) | `tsc` |
| H4 | `session.create` without `location` is born in the *server's* default directory, not the caller's project; prompting such a session boots a phantom location that outlives it. Agents resolve per directory, so `move` must precede `switchAgent` as a fallback. | `src/delegate.ts`, `src/probe.ts`, dispatch in `plugin/index.ts` | live | 2026-10-13 (commit `8401e22`), 2.0.27 | `create({title})`, read `location.directory` |
| H5 | Two plugin installs with the same `id` fail the second with `Duplicate plugin ID`. The failed instance's options are silently ignored. | (environment; no code consumer) | live | 2026-10-13, `/api/plugin` state | install twice, read `state` |
| H6 | A free-tier credential refuses provider calls made outside the app (`free tier can only be used from within OpenCode`); some catalog models are additionally withdrawn (`deprecated`). Detection cannot see either; only a request proves it. | `src/quarantine.ts` patterns, `src/probe.ts` | live | 2026-10-10–13, service log + `/orchestra probe` | headless `generate`/session turn |
| H7 | The agent registry speaks `Model.Ref` (`{id, providerID, variant}`), not the config shape. One entry without `id` makes the whole agent list unserializable (`GET /api/agent` → 400) and empties the TUI selectors. | `src/agents.ts` (`agentModel`) | live + type | 2026-10-13 (commit `8401e22`), 2.0.27; node_modules `@opencode/schema` agent types | `GET /api/agent` |
| H8 | The context hook event carries the session's tool catalog (`SessionContext.tools`: name → description + input). The mirror omits it; a future observer could read tool visibility straight off the event. | (unused; mirror gap) | type | SDK 2.0.26, node_modules `@opencode/plugin` promise session types | `tsc` |
| H9 | `AgentEditor` has no `add`; `update(id, …)` upserts, which is how agents are created at all. | `plugin/index.ts` `apply()` | type | SDK promise agent types | `tsc` |
| H10 | A plugin package loads by its root entry. `./plugin` needs an explicit config entry; a bare clone/symlink install resolves the root. | `index.ts`, `opencode.jsonc` | live | 2.0.27 (double-load episode, 2026-10-13) | install both ways, read `/api/plugin` |
| H11 | The `retry` hook carries `attempt: number` and fires per attempt — the host retries a doomed provider call ~10 times over ~84s. Quarantine must dedupe on `(sessionID, attempt`) or one 429 blocks a model for a fortnight. | retry hook in `plugin/index.ts`, `src/quarantine.ts` | live | 2026-10-10 (todo log); consistent with 2026-10-13 log bursts | deliberately failing model, count firings |
| H12 | `AgentEditor.default()` returns `void`. A mock that reads the default back promises what the host never does. | `plugin/index.ts` (`defaultAgent`) | type | SDK 2.0.26, node_modules `@opencode/plugin` promise agent types | `tsc` |
| H13 | The tool hooks require `id` (and `agent`, `messageID`) on both `execute.before` and `execute.after`. Position-matching fallbacks are harmless but unjustified. | `src/fanout.ts` | type | SDK 2.0.26, node_modules `@opencode/plugin` promise tool types | `tsc` |
| H14 | Transcript entries carry a host-generated `id` and `time.created`, and nothing that correlates them to a plugin's own record. So a delegation receipt cannot be identified by handle: consumption has to be detected from the text. | `src/receipts.ts` (`transcriptCarries`) | type | SDK 2.0.26, node_modules `@opencode/schema/dist/session-message.d.ts` (`Assistant`: `type`, `agent`, `model`, `id`, `time`) | `tsc` |

### H14 — what it rules out, and what it does not

Identifying a received delegation unambiguously, rather than by substring
search, is not available on this SDK: `Assistant` entries have an `id`, but it is
minted by the host and nothing in a transcript entry links it to a receipt this
plugin opened.

So the substring search stays, and what it costs is worth stating plainly:

- The haystack is the whole transcript, deliberately. The delegation tool's own
  result appearing there **is** the consumption event (`tests/receipts.test.ts`,
  "a CONSUMED receipt is not re-injected"). Narrowing the search to assistant
  prose would look tidier and would break the mechanism.
- What is not legitimate is a match on text the builder already had. The tool
  *input* — the question — has been in the transcript since the call was made,
  so a reply that quotes the question back retires a receipt without the builder
  having read anything. That is now excluded (`transcriptCarries`).
- `MIN_CONSUMPTION_MATCH` is the floor for the remaining case, and it is only
  load-bearing when a receipt has no recorded question. It had no test; it has
  one now.

### H1 verification log (the entry that earns the table its keep)

2026-10-13, private `opencode serve` instances + live catalog reads. Temp probe
tools, all removed afterwards:

- `add({name, description, execute})`, `+ plain-object input`, `+ Schema input`
  → all registered (codemode catalog immediately; a session called one).
- Same probes `+ options: { codemode: false }`, or `+ declared output`, or with a
  colliding name (`scout`) → never appeared in any catalog, no warn/error.
- `ctx.tool.list()` during setup (and 5s later) shows only the 23 host tools
  either way — it is not a valid observer.
- `editor.namespace()` never prefixed anything: adds under it behaved as bare
  names (which is why the originals collided). It is gone from the codebase.

## Facts the host documents that we do not use

Each with why it has no impact — an unused capability with no reason recorded
is how the next person wires it up wrong.

- `session.get` — mirrored, never called. No impact because sessions this
  plugin opens are tracked by id locally from `create`; nothing re-reads them.
- `session.interrupt`, `session.update` — never called. No impact because a
  delegation runs to `wait()` and is then removed; there is nothing to
  interrupt or patch mid-flight.
- `agent.list`, `agent.reload` — never called. No impact because `apply()`
  writes through `transform` unconditionally and the report reads back from the
  resolver state, not the host.
- `command.list` — never called. No impact because command names are fixed at
  registration; nothing enumerates them at runtime.
- `tool.list` — never called in shipped code. No impact because fan-out and
  evidence key off hook events, not the registry (and per H1 the registry
  wouldn't show our tools at setup time anyway).
- `storage.remove` — never called. No impact because both stores
  (quarantine, receipts) are overwritten whole, never deleted per key.
- `SessionRequestKind` on the model/http/ws hooks — never hooked. No impact
  because all session signals come from the session-level `context`/`retry`
  hooks, which don't carry it (H2).
- `SessionContext.tools` (H8) — never read. No impact today; it is the
  reserved observer for the next visibility question.

## Dead paths caused by host facts

- `event.kind === 'compaction'` inside the context handler was unreachable
  (H2: context events have no `kind`), so consumed receipts never re-opened.
  Fixed by registering the real `compaction` hook (H3).
- `editor.update` on an unknown tool id is silently ignored (documented SDK
  contract, `promise/tool.d.ts`). The `subagentFallback` armed/unavailable
  detection reads whether the updater *ran*, never whether it matched.
- `ToolEditorLike.default` read-back in `tests/harness.test.ts` asserts an
  invented getter (H12). Filed here; fix with the next test run since the
  harness cannot be executed in every environment.

## Re-verification commands

All against a private server so the background service is untouched:

```bash
# Boot, capture the password, boot a location (plugin setup runs on first
# location use, not at server start):
(opencode serve --port 54399 --log-level debug --print-logs > /tmp/opencode/serve.log 2>&1 &)
PASS=$(grep -o -E "server password .+" /tmp/opencode/serve.log | awk '{print $3}')
AUTH="Authorization: Basic $(printf 'opencode:%s' "$PASS" | base64 -w0)"

# H1/H10/H5: which plugins loaded, and their state:
curl -s -H "$AUTH" "http://127.0.0.1:54399/api/plugin?location%5Bdirectory%5D=/workspaces/opencode-orchestra"

# H7: agent list serializes (400 + missing-id error means the registry shape broke):
curl -s -H "$AUTH" "http://127.0.0.1:54399/api/agent?location%5Bdirectory%5D=/workspaces/opencode-orchestra" | head -c 300

# Commands registered (command transform is the control: it always works):
curl -s -H "$AUTH" "http://127.0.0.1:54399/api/command?location%5Bdirectory%5D=/workspaces/opencode-orchestra"

# H4: location-at-create:
curl -s -H "$AUTH" -X POST http://127.0.0.1:54399/api/session \
  -H 'Content-Type: application/json' -d '{"title":"probe"}'
# ^ must NOT return location.directory = "/" for a project session; a bare
# create with no project context does, and that is the phantom-workspace trap.

# Slash command without a model turn (deterministic command execution):
curl -s -H "$AUTH" -X POST "http://127.0.0.1:54399/api/session/$SES/command" \
  -H 'Content-Type: application/json' -d '{"name":"orchestra-probe","text":""}'

# H11: count retry-hook firings for one deliberately failing model and compare
# against quarantine's threshold before changing either number.
```

## Sources

- `node_modules/@opencode/plugin/dist/promise/session.d.ts` — `SessionHooks`,
  `SessionContext`, `SessionCompaction`, `SessionRetry`, `SessionDomain` Pick.
- `node_modules/@opencode/plugin/dist/promise/agent.d.ts` — `AgentEditor`.
- `node_modules/@opencode/plugin/dist/promise/tool.d.ts` — `ToolEditor`,
  `ToolHooks` (required `id`/`agent`), "missing IDs are ignored".
- `node_modules/@opencode/schema/dist/tool.d.ts:25-31` — `Tool.Options`.
- `node_modules/@opencode/schema/dist/agent.d.ts` — registry `Agent.Info`.
- Live: `/api/plugin`, `/api/agent`, `/api/command`, service log
  (`Failed to drain Session`, `loading plugin`, `Duplicate plugin ID`).
