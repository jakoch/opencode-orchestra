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

The first three need no config file; the last is the only route that takes options — which is why `defaultAgent` is unavailable elsewhere.

### Discovery requires a root entry

OpenCode loads a plugin package directory by its root entry. This repo's `index.ts` re-exports `plugin/index.ts`: without it, a clone into `.opencode/plugins/orchestra` is silently ignored. Keep the re-export if you vendor the files.

### Symlinks

Link the `plugins/` subdirectory (not the whole config dir) so OpenCode's `service.json` stays intact:

```sh
ln -s "$HOME/dotfiles/opencode-orchestra" ~/.config/opencode/plugins/opencode-orchestra
```

### Per-project config

```jsonc
// <project>/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "builder",
  "plugins": [{ "package": "./plugin", "options": { "defaultAgent": true } }]
}
```

Relative paths resolve from the config file that contains them. Project config overrides global, so pins can differ per repo.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | `false` keeps the plugin loaded but inert. |
| `defaultAgent` | `false` | Also make `builder` the default primary agent. |
| `defaultModel` | `false` | Also make new sessions start on the builder's model. See below. |
| `pin` | `.opencode/orchestra.json` | Pin file path relative to the project. `false` disables pinning. |
| `roles` | – | Force a role onto a model: `{ "advisor": "anthropic/claude-opus-4-1" }`. `null` disables a role entirely. |
| `variants` | – | Force a reasoning variant: `{ "scout": "low" }`. `null` drops the variant and uses the provider default. |
| `hideAdvisor` | `false` | Keep the advisor *and the skeptic* out of `@`-mention listings. Both stay callable by ID. |
| `steps` | – | Step ceilings per role: `{ "scout": 24 }`. |
| `debug` | `false` | Trace every session-backed delegation to `.opencode/orchestra-debug.jsonl`: which host call ran, how long, and the **shape** of the transcript returned. Shapes, never text. |
| `tracePath` | `.opencode/orchestra-debug.jsonl` | Where that trace goes. Absolute, or relative to the project. |
| `commands` | `true` | Register the slash commands. |
| `selftest` | `false` | Register `/orchestra-selftest`. |
| `probeTimeoutMs` | `45000` | Per-model budget for `/orchestra probe`. |
| `sessionDelegate` | `true` | Register session-backed `scout` / `advisor` / `skeptic` tools. Set `false` to register only plugin tools. |
| `delegateTimeoutMs` | `300000` | Budget for one delegated turn, end to end. |
| `quarantine` | `true` | Drop models that fail at request time. |
| `evidence` | `true` | Track files changed since the last verification run. |
| `loopGuard` | `true` | Circuit-break repeated tool calls or identical turns. |
| `context` | `true` | Warn against the model's real context window. |
| `contextWarnRatio` | `0.85` | Fraction of the window at which to warn. |
| `contextMaxTokens` | – | Override the context window for every model. |
| `maxConcurrentSubagents` | `2` | Concurrent subagent launches per session. Excess launches queue. `0` disables the gate. |
| `fanoutWaitMs` | `120000` | How long a launch waits for a slot before it is refused. |

### Delegation routes

A free-tier credential refuses the host's child-session subagent launch ("the free tier can only be used from within OpenCode"). The plugin registers `orchestra_scout` and `orchestra_advisor` tools instead, which run the same agents over an **ordinary** session: create, move into the project, switch agent, prompt, wait, read reply, remove. Same agent, same prompt — only the delivery differs.

If you touch `src/delegate.ts`:

- The session **must be moved** into the project before the agent switch. Sessions are created in the server's default directory; agents are per directory; a mismatch fails silently.
- The transcript is `type: "assistant"` with a `content` array — not `role`/`parts`.

### Why `maxConcurrentSubagents` exists

The `subagent` permission gates *which* agent runs, not how many at once. On a capped tier an unbounded fan-out turns a rate limit into a failed session. The gate runs before dispatch: launches past the limit wait instead of failing. Only a launch that cannot get a slot within `fanoutWaitMs` is refused, naming what was launched.

Precedence: plugin options, then the pin file, then live detection. An option or pin naming an unavailable model is reported and falls back.

## Choosing models yourself

Detection is a default, not a cage. Three levels of override:

**One role** — via plugin options, which win over everything else:

```jsonc
"options": {
  "roles": { "advisor": "anthropic/claude-opus-4-1", "scout": null },
  "variants": { "builder": "high" }
}
```

`null` on a role disables it: no agent is registered, skipped when pinning.

**The whole assignment** — `/orchestra-pin` writes the current picks to `.opencode/orchestra.json`, worth committing because without it a provider upgrade silently re-roles your team:

```json
{
  "generator": "opencode-orchestra",
  "updated": "2026-10-09T00:00:00.000Z",
  "roles": {
    "builder": { "model": "anthropic/claude-sonnet-4-5", "variant": "high" }
  }
}
```

**The prompts** — define the agent yourself in `.opencode/agents/advisor.md`. The plugin keeps your prompt and permissions, only retargets the model. Report marks the role as `yours, model retargeted`.

## Debugging a delegation that returns nothing

Set `"debug": true`, then read `.opencode/orchestra-debug.jsonl`:

```
{"t":1757..,"event":"step","step":"create","outcome":"ok","ms":3}
{"t":1757..,"event":"step","step":"wait","outcome":"failed","error":"timed out after 300000ms while wait"}
{"t":1757..,"event":"failed","error":"timed out after 300000ms while wait"}
```

Read it like this:

- **`step` with `outcome:"failed"`** — names the host call that died. No `context` line, so the turn never got that far.
- **`context` line whose `shape` lacks `type=assistant`** — transcript came back in an unmatched shape: the reply was never missing, just unread.
- **`context` line followed by `{"extracted":false}`** — transcript well-formed but genuinely held no text: failed at the provider.

It records shapes, never text. A diagnostic must never be the reason a dispatch fails, so write failures are swallowed.

## Why `defaultModel` exists

A session's own model selection wins over an agent's `model`. Binding a model to the `builder` agent is not enough: a session with no explicit `model` falls back to the catalog default — newest available, arbitrary, possibly rate-limited. `/orchestra` warns when they disagree.

Either let the plugin set it:

```jsonc
"options": { "defaultModel": true }
```

Or do it declaratively, which wins over anything the plugin does:

```jsonc
{ "model": "anthropic/claude-sonnet-4-5" }
```

Model IDs are case-sensitive and come from the catalog, not the display name: `anthropic/claude-opus-4-1` resolves, `anthropic/ClaudeOpus` does not. A wrong `model` is ignored silently, not reported. Check IDs with `opencode api get /api/model`.

## Without the plugin

Every role is an ordinary OpenCode agent — same setup as plain config. `/orchestra-pin` prints a ready-to-paste `agents` block:

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

Model IDs here are examples. If the plugin is loaded alongside an agent of the same name, the plugin only retargets the model — your prompt and permissions win.

The plugin exports a plain `{ id, setup }` object, which is what OpenCode reads; install `@opencode/plugin` only to type-check the entrypoint against the published contract.
