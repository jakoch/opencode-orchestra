# Troubleshooting

Every item here is something that actually happened while building this.

## `OpenCode's free tier can only be used from within OpenCode`

The error is about **who is making the request**, not which model was chosen. A free-tier credential refuses calls that originate outside the OpenCode app:

| Route | Result |
| --- | --- |
| `ctx.generate.text` | refused |
| host `subagent` launch (child session) | refused |
| a session the plugin opens itself | **accepted** |

The last row is the whole basis of `orchestra_scout` / `orchestra_advisor`: an ordinary session is not a child session, and the same model answers on it.

A refusal arriving from a session the plugin did **not** open says nothing about the model — it was refused for being a child session. Charging it to the model anyway put the model on the dispatch skip list, walking past models that had been answering all along. Three models carried such a record on this project before it was found.

From inside a project, why each reading was wrong:

- `/orchestra` reports roles as `detected` while scout is dead. The catalog still lists those models as `active`, and detection cannot see the difference — what `unverified` is for.
- A probe may report one model answering and every other refusing. That is not a property of the models; it is which route happened to be accepted.
- `AI.Error.Authentication` in `~/.local/share/opencode/log/opencode.log` is the real signature. Check the log before believing any model-level explanation.

Nothing to configure here. No pin, weight, or `roles` override makes a refused route work. What helps:

- Call `orchestra_scout` / `orchestra_advisor` rather than the host's `subagent` tool. The builder prompt names them for this reason.
- Run the work in the TUI, where requests originate inside the app.
- Connect a credential that permits API-origin calls (`/connect`).
- Read `/orchestra` for *what is assigned*, and `/orchestra probe` for *what answers* — but trust the probe only when it says `answered via a session`. A refusal from `generate.text` alone tells you about the caller, not the model.

`/orchestra` also reports the wrapper itself: either that N launches were rerouted, or that the host does not expose its `subagent` tool to plugins and `orchestra_scout` is the only route available.

## An agent answers nothing, with no error

A delegated turn can end `idle: failed` with no assistant message and no error — almost always the agent not resolving, not the model refusing.

Sessions created by a plugin are born in the **server's default directory** (`/root` in a container), while project agents are registered per directory. So `switchAgent('scout')` targets an agent that does not exist there. Check it:

```sh
opencode api get "/api/agent?location[directory]=/root"
```

If your roles are missing from that list but present for the project directory, the session has to be moved before the agent switch. `session.move()` does it; `src/delegate.ts` calls it for exactly this reason.

## A probe says a model answered, but the model never replies elsewhere

`generate.text` runs without a session, which a free-tier credential refuses. The probe falls back to a real session, so it can succeed where everything else fails — including the delegated agents. Treat a probe success as evidence about the *route*, and confirm the role you care about before relying on it.

## `Rate limit exceeded` on the first run

The session is on the catalog's newest model, not the builder's, and that model is capped. A session's model wins over an agent's, so binding `builder` to a model does not change what the session runs on.

Check the run header, which prints `agent · model`, then either switch it for the session (`/model`, or `--model` for `opencode run`) or make it stick:

```jsonc
{ "model": "provider/id" }
// or
"options": { "defaultModel": true }
```

`/orchestra` prints a `Session model` section whenever the two disagree.

## `/orchestra` prints the command as literal text

`opencode run` does not dispatch slash commands; it sends them as a prompt, so the model tries to answer the string `/orchestra`. Use the TUI or Mini, or post the command yourself:

```sh
opencode api post "/api/session/<id>/command" --data '{"name":"orchestra","text":""}'
```

## A model looks dead but the catalog says `active`

The catalog is upstream-maintained and can be wrong in the direction that hurts: `exo-free` was listed `status: "active", enabled: true` while the provider rejected every call.

The plugin learns from real failures: terminal errors (deprecated, not found, 404/410) quarantine immediately; rate limits only after three occurrences so one busy minute does not cost you a model. Quarantined models are dropped from detection and the team is re-roled without a restart. Records age out after 14 days; `/orchestra` lists what is excluded and why. To force a quarantined model back sooner, delete the plugin's `.opencode/` storage.

## A refusal is recorded against the wrong subject

A refusal on a session the plugin opened should skip that model for dispatch; a refusal on a session it did not open (the host's own `subagent` launches) says nothing about the model. Skipping a model because a child session was refused is expensive: the model is fine, the dispatch quietly routes around it, and nothing in the report distinguishes "this model refused" from "this model was never asked".

The plugin now attributes a refusal only when it came from a session it opened itself, so the `rejected` treatment below applies to refusals genuinely about the model. Records written before that distinction existed still age out on the normal 14-day TTL — delete `.opencode/` storage to clear sooner.

The probe sees what actually answers:

```sh
/orchestra probe
```

It sends one minimal request per assigned model — no session, no tools, no history — and reports `ok`, `refused` or `unverified`. A timeout reports `unverified`, never `refused`, so a bad network cannot blacklist a healthy model. Probes never write storage.

If a role comes back refused, pin it to something that answered:

```jsonc
{ "roles": { "scout": "provider/id" } }
```

One consequence: scout's ranking is decided almost entirely by speed — on an all-free catalog every model has identical price and cheapness carries no information. If the fast family is refused, scout's candidate set is unusable and the resolver says so rather than picking silently.

## Edits to `src/` have no effect

OpenCode caches plugin modules per path in its background service. Run `opencode service restart` to reload it.

## A role has no model

No tool-capable model is available for that project. Models are per project, so credentials configured elsewhere do not carry over. Connect one with `/connect`. `/orchestra` says `nothing detected` when this happens.

## Cloned into `.opencode/plugins/` and nothing happened

OpenCode loads a plugin package directory by its **root entry**. A clone without a top-level `index.ts` is skipped silently — no warning, no plugin in `opencode api get /api/plugin`. Check the state there:

```sh
opencode api get "/api/plugin?location[directory]=$PWD"
```

Two other silent cases: a `plugins/` directory next to a project-root `opencode.jsonc` is not auto-discovered (it must be under `.opencode/`), and a config entry only needs the *directory* — `{"package": "./plugin"}`, never `"./plugin/index.ts"`.

If you vendored the files instead of cloning, keep the root `index.ts` re-export; without it, only the configured install path works.

## The plugin fails to load

Check `opencode api get "/api/plugin?location[directory]=<project>"` for `status` and `error`. The usual cause is a TypeScript build error naming a line, e.g. `BuildMessage: Unexpected }`. `/orchestra-selftest` exercises the whole module graph, so if it runs, the plugin loaded.

## A role has the wrong model

Detection ranks what the catalog advertises, using family keywords as a proxy for capability. It is a heuristic, not a benchmark.

- `/orchestra all` prints the full score table so you can see why a model won.
- Pin the role instead of arguing with the weights: `"roles": { "advisor": "provider/id" }`, or run `/orchestra-pin`.
- The weights are one edit in `src/roles.ts`; `WEIGHTS` sums to 1 per role and the self-test asserts the resulting invariants.

## A prompt change broke a role silently

The three system prompts are plain text with no assertions on them. After editing `src/prompts.ts`, run `/orchestra` and confirm the report still lists the role as `from plugin` rather than `yours, model retargeted`.

## The scout is being rate limited

Subagent fan-out is bounded: launches past `maxConcurrentSubagents` (2 by default) queue instead of firing at once, the usual cause of a scout burst on a capped tier. If you still hit a limit:

- raise the ceiling if the provider allows it — `"maxConcurrentSubagents": 3`
- or pin the scout to a cheaper tier: `"roles": { "scout": "provider/id" }`
- or disable the role entirely with `"roles": { "scout": null }`

A refusal message naming the agent means the gate gave up waiting, not that the model misbehaved; raise `fanoutWaitMs` for slow scouts.
