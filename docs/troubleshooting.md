# Troubleshooting

Every item here is something that actually happened while building this.

## `Rate limit exceeded` on the first run

The session is on the catalog's newest model, not the builder's, and that model
is capped. A session's model wins over an agent's, so binding `builder` to a
model does not change what the session runs on.

Check the run header, which prints `agent · model`, then either switch it for the
session (`/model`, or `--model` for `opencode run`) or make it stick:

```jsonc
{ "model": "provider/id" }
// or
"options": { "defaultModel": true }
```

`/orchestra` prints a `Session model` section whenever the two disagree.

## `/orchestra` prints the command as literal text

`opencode run` does not dispatch slash commands; it sends them as a prompt, so
the model tries to answer the string `/orchestra`. Use the TUI or Mini, or post
the command yourself:

```sh
opencode api post "/api/session/<id>/command" --data '{"name":"orchestra","text":""}'
```

## A model looks dead but the catalog says `active`

The catalog is upstream-maintained and can be wrong in the direction that hurts:
`exo-free` was listed `status: "active", enabled: true` while the provider
rejected every call with `Model exo-free has been deprecated`.

The plugin learns this from real failures: terminal errors (deprecated, not
found, 404/410) quarantine immediately, rate limits only after three occurrences
so one busy minute does not cost you a model. Quarantined models are dropped from
detection and the team is re-roled without a restart. Records are durable and age
out after 14 days, and `/orchestra` lists what is excluded and why. To force a
quarantined model back sooner, delete the plugin's `.opencode/` storage or wait
it out.

## Edits to `src/` have no effect

OpenCode caches plugin modules per path in its background service. Run
`opencode service restart` to reload it. A fresh directory also forces a real
plugin activation, which is why a copy elsewhere behaves differently from an
edited checkout.

## A role has no model

No tool-capable model is available for that project. Models are per project, so
credentials configured elsewhere do not carry over. Connect one with `/connect`.
`/orchestra` says `nothing detected` when this happens.

## Cloned into `.opencode/plugins/` and nothing happened

OpenCode loads a plugin package directory by its **root entry**. A clone without
a top-level `index.ts` is skipped silently — no warning, no plugin in
`opencode api get /api/plugin`. Check the state there rather than guessing:

```sh
opencode api get "/api/plugin?location[directory]=$PWD"
```

Two other silent cases: a `plugins/` directory next to a project-root
`opencode.jsonc` is not auto-discovered (it must be under `.opencode/`), and a
config entry only needs the *directory* — `{"package": "./plugin"}`, never
`"./plugin/index.ts"`.

If you vendored the files instead of cloning, keep the root `index.ts`
re-export; without it, only the configured install path works.

## The plugin fails to load

Check `opencode api get "/api/plugin?location[directory]=<project>"` for a
`status` and `error`. The usual cause is a TypeScript build error, whose message
names a line, e.g. `BuildMessage: Unexpected }`. `/orchestra-selftest` also
exercises the whole module graph, so if it runs, the plugin loaded.

## A role has the wrong model

Detection ranks what the catalog advertises, using family keywords as a proxy for
capability. It is a heuristic, not a benchmark.

- `/orchestra all` prints the full score table so you can see why a model won.
- Pin the role instead of arguing with the weights:
  `"roles": { "advisor": "provider/id" }`, or run `/orchestra-pin`.
- The weights themselves are one edit in `src/roles.ts`; `WEIGHTS` sums to 1 per
  role and the self-test asserts the resulting invariants.

## A prompt change broke a role silently

The three system prompts are plain text with no assertions on them. After
editing `src/prompts.ts`, run `/orchestra` and confirm the report still lists the
role as `from plugin` rather than `yours, model retargeted`.

## The scout is being rate limited

Subagent fan-out is bounded: launches past `maxConcurrentSubagents` (2 by
default) queue instead of firing at once, the usual cause of a scout burst on a
capped tier. If you still hit a limit:

- raise the ceiling if the provider allows it — `"maxConcurrentSubagents": 3`
- or pin the scout to a cheaper tier: `"roles": { "scout": "provider/id" }`
- or disable the role entirely with `"roles": { "scout": null }`

A refusal message naming the agent means the gate gave up waiting, not that the
model misbehaved; raise `fanoutWaitMs` for slow scouts.
