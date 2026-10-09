# Roles

Three agents, each with one job. The prompts are contracts, not personas: the
scout returns evidence, the builder ships work, the advisor only judges.

## Builder

Primary agent. Owns implementation, runs the project's checks, and decides when
to escalate.

- **Model:** best coding fit with room for real edits. Mid-tier by design: it
  runs on every task.
- **Variant:** the middle reasoning effort, when the model exposes variants. Low
  makes a workhorse slow, max makes it expensive.
- **Permissions:** write access, `git push` asks first, subagents allowed.

The prompt makes delegation explicit: search through `scout`, escalate to
`advisor` at checkpoints. A builder that searches on its own burns the context
implementation needs.

## Scout

Read-only search agent. Fast and cheap, because it is called many times per task.

- **Model:** lowest latency and price in the catalog, preferring families that
  advertise speed (`flash`, `haiku`, `lightning`).
- **Variant:** the cheapest reasoning variant, when one exists.
- **Permissions:** no edits, shell, subagents or questions. Read, glob, grep and
  web stay open; `.env` reads still ask.

The prompt caps the output shape: answer first, then `path:line` references, then
at most five lines of extras. The caller's context is the scarce resource, so the
scout returns locations and conclusions rather than transcripts.

## Advisor

Read-only reviewer on the strongest reasoning model. On call, not in the loop.

- **Model:** deepest reasoning headroom available, discounted if the family is a
  preview. Price matters least: it runs a few times per task.
- **Variant:** the strongest reasoning variant offered.
- **Permissions:** identical to the scout — no editing, no commands, no spawning.
  That is the whole cost-control argument: it can only read and judge.
- **Visibility:** listed by default so the builder can discover it. Set
  `hideAdvisor: true` to keep it out of `@`-mention listings while it stays
  callable by ID.

The prompt requires a verdict (`approve`, `approve with notes`, `block`), at most
five findings with file references, and no code. At a checkpoint the builder
passes the diff, the failing command, and one question.

### When the builder calls the advisor

Four checkpoints, named in the builder prompt:

1. a test or build failed twice for the same reason
2. the task is about to be declared finished
3. an architectural tradeoff is undecided
4. the scout's findings contradict what the code appears to do

`/checkpoint` triggers the same review on demand.

## Permissions

Rules are ordered and the last match wins, so broad allows come first. Assigning
`permissions` to an agent **replaces** the default base policy rather than
appending to it, which is why the read-only roles restate the `.env` guards
themselves.

```jsonc
// scout and advisor
[
  { "action": "edit",  "resource": "*", "effect": "deny" },
  { "action": "shell", "resource": "*", "effect": "deny" },
  { "action": "read",  "resource": "*.env", "effect": "ask" },
  { "action": "read",  "resource": "*", "effect": "allow" },
  { "action": "glob",  "resource": "*", "effect": "allow" },
  { "action": "grep",  "resource": "*", "effect": "allow" }
]
```

## Customizing

Override a prompt by defining the agent yourself, for example in
`.opencode/agents/advisor.md`. The plugin keeps your prompt and permissions and
only retargets the model; the report marks the role as `yours, model retargeted`.

To change what a role *is*, edit the spec in `src/agents.ts` (permissions, mode,
colour, steps) or the prompt in `src/prompts.ts`. To change which model a role
gets, either pin it (`/orchestra-pin`) or adjust the weights in `src/roles.ts`
and check the effect with `/orchestra all`.
