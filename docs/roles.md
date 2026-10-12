# Roles

Four agents, each with one job. The prompts are contracts, not personas: the
scout returns evidence, the builder ships work, the advisor judges, and the
skeptic argues against building the thing at all.

## The verification boundary

**Who may verify what.** The producing role owns its own work; the builder may
re-verify anything it receives, and nothing gates on an advisor's opinion.

This is the rule that keeps the delegation honest, so it is worth stating
precisely rather than leaving to inference:

| | May run verification | Owns | Re-verifying it |
| --- | --- | --- | --- |
| **Scout** | **No** — `shell: deny`, `edit: deny` | the search: what it looked at and where | pointless; it ran the search |
| **Advisor** | **No** — same denies | the judgement: a verdict and its reasons | **forbidden**, and see below |
| **Skeptic** | **No** — same denies | whether the proposal should exist at all | **forbidden**, and see below |
| **Builder** | Yes — `*: allow` | whether the work ships | expected |

Two consequences follow, and they are the whole point:

- **A scout's findings are structurally unbacked.** Scout cannot run a test, a
  build, or a command. It reports `path:line` evidence it read; it cannot show
  you that the thing at that line still works. Only the builder can settle that,
  which is why "a handoff is not completion" applies here: re-verification
  belongs to the consumer because the producer *cannot* do it.
- **Re-verification must not duplicate the producing role.** The builder should
  not re-run a scout's searches — scout already ran them and paid for the
  context. It *should* run the checks scout structurally could not.

**An advisor's verdict is advisory, full stop.** Nothing blocks on it, nothing
gates on it, and no fallback silently retries around it. gem-team's rule — *"the
orchestrator never re-verifies or second-guesses specialist output"* — is right
for a specialist that owns its work end to end, and wrong here: our advisor
cannot run anything, so deferring to it absolutely would mean acting on an
unverified opinion with no one left to check. The line we draw instead:

> The builder may re-verify what it is told. It may not re-litigate what a role
> was asked to decide. And it never defers to a role that cannot verify itself.

**The skeptic argues about proposals, not about runs.** It is inside the
boundary for the same reason the advisor is: `shell: deny`, so it cannot
re-verify anything and must not pretend to. Its subject is the *design* — should
this exist, why this shape, can it be simpler — never the outcome of a command
the builder already ran. A skeptic that re-litigates a passing test is doing the
builder's job with fewer tools, which is exactly what the denies prevent.

### The handoff envelope

Scout and advisor return the same four sections, so the builder can consume
them without parsing prose:

| Section | What it carries |
| --- | --- |
| `FINDINGS` | the answer itself — scout leads with it, advisor with its `VERDICT` |
| `FILES` | the `path:line` references those findings point at |
| `CONFIDENCE` | `high` / `medium` / `low` — a closed union, checked at compile time |
| `OPEN QUESTIONS` | what the role could not settle |

**It is a contract with a soft edge, not a schema.** Any section that would be
empty is left out, and `FILES` in particular is droppable when each finding
already ends with its own reference. The price of that softness is real: a
consumer can rely on findings carrying references, but *not* on `FILES` being
present.

It is enforced in the prompt and nowhere else — deliberately. A parser that
rejects a malformed return is a new failure mode, and this repo has spent enough
of today learning that a strict parser would have been a poor trade.

`/checkpoint` embeds the advisor's contract verbatim, so the envelope appears in
that request too. **The skeptic does not use this envelope** — see below.

### Why this is written down

Because its absence is expensive. With no rule stated, a comment once claimed
the builder's prompt was injected when it was not, and nothing felt wrong about
it — the *spirit* was enforced everywhere and the *boundary* nowhere.
`src/quarantine.ts` and `src/evidence.ts` are the two places that decide
what counts as verified; both refer here.

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
implementation needs. `tests/prompts.test.ts` asserts that the builder prompt
keeps both a trigger condition for calling `scout` and a non-empty advisor
checkpoint list, so the contract cannot be quietly dropped.

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
  `hideAdvisor: true` to keep it and the skeptic out of `@`-mention listings
  while they stay callable by ID.

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

## Skeptic

Read-only adversarial reviewer. It answers the questions nobody else on this
project asks: **should we build this at all**, **why this way**, and **can it be
simpler**. The advisor judges whether a thing is correct; the skeptic argues
whether it should exist.

- **Model:** reasoning-weighted like the advisor but cheaper — it runs one turn
  per `/panel`, not continuously. Discounted if the family is a preview, because
  a skeptic on a preview model is not a skeptic.
- **Variant:** the *second*-highest reasoning effort when the model offers
  several. When a thin catalog forces it onto the advisor's model, a different
  effort is the only remaining hedge against two reviewers agreeing because they
  are literally the same weights.
- **Permissions:** identical to the advisor and the scout. It can only read and
  object, never act.
- **Visibility:** listed by default; `hideAdvisor: true` hides it too, since both
  are on-call reviewers rather than part of a normal turn.

### Why it is a role and not an advisor mode

Because its value *is* independence. A panel's whole point is that the critique
comes from somewhere other than the proposal, and that collapses if the critic
shares weights with the author. Three consequences, all enforced in
`src/roles.ts` and asserted in `tests/skeptic.test.ts`:

- **It is bound to a different model from the builder.** Not a preference — a
  rule. Sharing there means reviewing a proposal with the weights that produced
  it, which is the correlation that defeats the role.
- **Its verdict vocabulary is disjoint from the advisor's** — `drop`, `reshape`,
  `simplify`, `proceed` against `approve`, `approve with notes`, `block`. Two
  roles emitting the same word look like they agree when they were simply asked
  different questions.
- **It does not use the handoff envelope.** It argues, so it has its own
  sections (`VERDICT`, `FATAL FLAW`, `HIDDEN ASSUMPTIONS`, `SIMPLER FORM`,
  `STRESS TESTS`, `CONFIDENCE`). `VERDICT`, `FATAL FLAW` and `CONFIDENCE` are
  mandatory; the rest are omitted when empty, because a section's *absence* is
  ambiguous — it could mean "none" or "did not check".

### When the catalog cannot keep them apart

A thin catalog cannot hold four roles on four models. The resolver then prefers
any model no other role holds, and failing that one outside the builder's, and
says so in a note either way. `/panel` repeats the warning in the request
itself, because a correlated second opinion that reads like independence is
worse than an honest admission of it. The role never goes unassigned: a panel
that silently disappears is worse than a correlated one.

### `/panel`

Separate from `/checkpoint` on purpose. A checkpoint is one advisor turn; a
panel is two reviewer turns plus a synthesis, and folding it in would hide that
cost behind a command people already invoke reflexively.

The command **dispatches both reviewers itself**, each through `dispatchRole`
and therefore each over an ordinary session, rather than handing the builder an
instruction to launch them. This was not the first design: the original asked
the builder to call `orchestra_skeptic` and `orchestra_advisor` by name, and
that failed against the real host, because the builder's natural `subagent`
launch opens a *child* session that a free tier refuses — and "use this tool
instead" is not an instruction a model reliably follows. Routing in code removes
the choice entirely.

Independence is structural rather than instructed: both `dispatchRole` calls are
started together in one `Promise.all`, so neither turn can exist before the
other finishes, and neither prompt contains the other's verdict. The command then
returns both reviews to the builder to present, with an explicit instruction not
to merge or average them — the disagreement is the finding worth the tokens.

Three things it will not do:

- **Run with no argument.** The proposal is the command argument; invoked bare it
  says so rather than spending two model turns on an empty subject.
- **Re-run its own reviews.** They are already complete when the builder sees them.
- **Repeat a session error.** A refusal is visible in the TUI already; the panel
  reports only *how many opinions are missing*, because a missing reviewer reads
  as agreement unless it is named as missing.

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
