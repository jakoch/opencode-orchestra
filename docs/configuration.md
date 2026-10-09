# Configuration

Everything here is optional. The default install needs nothing but a `plugins`
entry.

## Install shapes

| Route | Scope | Options |
| --- | --- | --- |
| clone into `.opencode/plugins/<dir>` | one project | none |
| clone or symlink into `~/.config/opencode/plugins/<dir>` | every project | none |
| `opencode plugin add github:jakoch/opencode-orchestra` | every project | none |
| `plugins: [{ "package": "./plugin" }]` | one project | yes |

The first three need no config file; the last is the only route that takes
options, which is why `defaultAgent` is unavailable in the others.

### Discovery requires a root entry

OpenCode loads a plugin *package directory* by its root entry. This repository's
`index.ts` re-exports `plugin/index.ts` for exactly that reason: without it, a
clone into `.opencode/plugins/orchestra` is silently ignored, while a config
entry pointing at `./plugin` still works. If you vendor the files into your own
repo, keep the re-export or point the config at the directory that has the entry.

### Symlinks

A symlink into the global plugins directory works and is the usual dotfiles
pattern:

```sh
ln -s "$HOME/dotfiles/opencode-orchestra" ~/.config/opencode/plugins/opencode-orchestra
```

OpenCode writes `~/.config/opencode/service.json`, so link the `plugins/`
subdirectory rather than replacing the whole config directory.

### Per-project config

```jsonc
// <project>/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "builder",
  "plugins": [{ "package": "./plugin", "options": { "defaultAgent": true } }]
}
```

Relative paths resolve from the config file that contains them. A project config
overrides the global one, so pins can differ per repo.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | `false` keeps the plugin loaded but inert. |
| `defaultAgent` | `false` | Also make `builder` the default primary agent. |
| `defaultModel` | `false` | Also make new sessions start on the builder's model. See [below](#why-defaultmodel-exists). |
| `pin` | `.opencode/orchestra.json` | Pin file path relative to the project. `false` disables pinning. |
| `roles` | – | Force a role onto a model: `{ "advisor": "anthropic/claude-opus-4-1" }`. `null` disables a role entirely. |
| `variants` | – | Force a reasoning variant: `{ "scout": "low" }`. `null` drops the variant and uses the provider default. |
| `hideAdvisor` | `false` | Keep the advisor out of `@`-mention listings. It stays callable by ID. |
| `steps` | – | Step ceilings per role: `{ "scout": 24 }`. |
| `commands` | `true` | Register the slash commands. |
| `selftest` | `false` | Register `/orchestra-selftest`. |
| `quarantine` | `true` | Drop models that fail at request time. |
| `evidence` | `true` | Track files changed since the last verification run. |
| `loopGuard` | `true` | Circuit-break repeated tool calls or identical turns. |
| `context` | `true` | Warn against the model's real context window. |
| `contextWarnRatio` | `0.85` | Fraction of the window at which to warn. |
| `contextMaxTokens` | – | Override the context window for every model. |
| `maxConcurrentSubagents` | `2` | Concurrent subagent launches per session. Excess launches queue. `0` disables the gate. |
| `fanoutWaitMs` | `120000` | How long a launch waits for a slot before it is refused. |

### Why `maxConcurrentSubagents` exists

A session's model selection does not bound how many subagents the builder
launches in one message, and the `subagent` permission gates only *which* agent
runs. On a capped tier an unbounded fan-out turns a rate limit into a failed
session.

The gate runs before dispatch, turning a stampede into a queue: launches past the
limit wait instead of failing, because a model refused four searches usually
drops three. Only a launch that cannot get a slot within `fanoutWaitMs` is
refused, naming what was launched.

Two consequences: a slow scout holds its slot while it runs, so a limit of 2
means one scout while you work or a scout plus the advisor at a checkpoint; and
the gate is per session, so two sessions do not block each other.

Precedence, highest first: plugin options, then the pin file, then live
detection. An option or pin naming an unavailable model is reported and falls
back.

## Choosing models yourself

Detection is a default, not a cage. Three levels of override:

**One role** — via plugin options, which win over everything else:

```jsonc
"options": {
  "roles": { "advisor": "anthropic/claude-opus-4-1", "scout": null },
  "variants": { "builder": "high" }
}
```

`null` on a role disables it: no agent is registered, and it is skipped when
pinning.

**The whole assignment** — `/orchestra-pin` writes the current picks to
`.opencode/orchestra.json`, which is worth committing, because without it a
provider upgrade silently re-roles your team.

```json
{
  "generator": "opencode-orchestra",
  "updated": "2026-10-09T00:00:00.000Z",
  "roles": {
    "builder": { "model": "anthropic/claude-sonnet-4-5", "variant": "high" }
  }
}
```

**The prompts** — define the agent yourself in `.opencode/agents/advisor.md`.
The plugin keeps your prompt and permissions and only retargets the model; the
report marks such roles as `yours, model retargeted`.

## Why `defaultModel` exists

A session stores its own model selection, and that selection wins over an
agent's `model`. Binding a model to the `builder` agent is therefore not enough:
a session with no explicit `model` falls back to whatever OpenCode picks as the
catalog default — the newest available model, which is arbitrary and may be
rate-limited. `/orchestra` warns whenever the two disagree.

Either let the plugin set it:

```jsonc
"options": { "defaultModel": true }
```

or do it declaratively, which wins over anything the plugin does:

```jsonc
{ "model": "anthropic/claude-sonnet-4-5" }
```

Model IDs are case-sensitive and come from the catalog, not the display name:
`anthropic/claude-opus-4-1` resolves, `anthropic/ClaudeOpus` does not, and a
wrong `model` in config is ignored silently rather than reported. Check the
available IDs with `opencode api get /api/model`.

## Without the plugin

Every role is an ordinary OpenCode agent, so the same setup works as plain
config. `/orchestra-pin` prints a ready-to-paste `agents` block:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "builder",
  "agents": {
    "builder": {
      "description": "Primary orchestrator...",
      "mode": "primary",
      "model": "anthropic/claude-sonnet-4-5#high",
      "system": "You are the Builder...",
      "permissions": [{ "action": "shell", "resource": "git push *", "effect": "ask" }]
    },
    "scout": {
      "mode": "subagent",
      "model": "anthropic/claude-haiku-4-5",
      "permissions": [
        { "action": "edit", "resource": "*", "effect": "deny" },
        { "action": "shell", "resource": "*", "effect": "deny" }
      ]
    },
    "advisor": {
      "mode": "subagent",
      "hidden": true,
      "model": "anthropic/claude-opus-4-1#high"
    }
  }
}
```

Model IDs here are examples. If the plugin is loaded alongside an agent of the
same name, the plugin only retargets the model — your prompt and permissions win.

The plugin itself has no runtime dependencies. It exports a plain
`{ id, setup }` object, which is what OpenCode reads; install `@opencode/plugin`
only if you want the entrypoint type-checked against the published contract.
