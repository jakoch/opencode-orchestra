# opencode-orchestra — Feature Inventory

Every file in `src/` with its feature and purpose, derived from the code itself.

---

## Core Resolution

### `src/roles.ts` — Role Resolution & Assignment
**Feature:** Weighted scoring + distinct-model preference + variant selection + fallback chains  
**Purpose:** Takes the live catalog, scores each model per role (builder/scout/advisor/skeptic) using role-specific weights (`WEIGHTS`), picks one model per role preferring distinct models, selects reasoning variants via `chooseVariant`, and builds `fallbackChain` for dispatch when the assigned model fails.  
**Key exports:** `resolveRoles`, `score`, `chooseVariant`, `fallbackChain`, `WEIGHTS`, `MATURITY_PENALTY`  
**Dependencies:** `infer.ts` (candidate building), `types.ts` (shared types)

### `src/infer.ts` — Capability Inference from Catalog
**Feature:** Heuristic signal derivation (speed, reasoning, coding, cheapness, context, output, recency)  
**Purpose:** The catalog has price, limits, release date, declared variants. It does NOT have "is this fast" or "is this a coder". This module derives those from family keywords + catalog facts so the scorer works for any provider (Claude, local Ollama, free-tier gateway). Every heuristic is explainable via `tags` so the report can say *why* a model was picked.  
**Key exports:** `buildCandidates`, `isUsable`, `variantEffort`, `effortFromWord`  
**Signals produced:** `cheapness`, `context`, `outputLimit`, `recency`, `reasoning`, `speed`, `coding`, `experimental`, `variantEffort`, `tags`, `family`

### `src/types.ts` — Shared Type Definitions
**Feature:** Structural, permissive mirrors of OpenCode shapes  
**Purpose:** Shapes mirror fields OpenCode exposes on `Model.Info` but are kept structural/permissive so the resolver runs against raw catalog, API snapshot, or test fixture without pulling in `@opencode/plugin`. Defines `RoleName`, `ModelRef`, `Signals`, `RoleAssignment`, `ResolveInput/Output`, `HandoffEnvelope`, `Claim`, `ClaimSupport`, `FileRef`, `HANDOFF_LIMITS`, `HANDOFF_CONFIDENCE`.

---

## Delegation & Session Management

### `src/delegate.ts` — Ordinary Session Delegation
**Feature:** Runs an agent over a normal session (not a child session) — the route that works on free-tier credentials  
**Purpose:** The host's built-in `subagent` launch creates a child session, which free-tier credentials refuse. This runs the same agent through an ordinary session: `create` (with location at create time, critical), optional `move` if host ignored location, `switchAgent`, optional `switchModel`, `prompt` (steer delivery), `wait`, `context`. Returns `DelegationResult`, whose `status` is the decision and whose `ok` is a view over it — most call sites only need "is there an answer", but a caller choosing between retry and belief needs to know whether the provider refused, the turn was never observed, or the work itself broke. Includes per-step tracing (`step` wrapper) and `extractReply`/`extractFailure` from transcript.  
**Key exports:** `delegateToAgent`, `extractReply`, `extractFailure`, `DelegationInput`, `DelegationResult`, `result`

### `src/capabilities.ts` — Runtime Capability Probing + Session Adapter
**Feature:** Degrades per missing member with one warn + one report line; session adapter replaces hand-rolled literals  
**Purpose:** Instead of trusting the hand-kept mirror in `plugin-types.ts`, `setup` walks a table of 24 capabilities with `typeof` and degrades: one log line, one report line, never a faked success. Hook registration is NOT a degrade path — a rejected hook is a host contract violation and fails loudly. `sessionAdapter` wraps each `session.*` call so an absent member rejects with a fixed message naming the capability — never a bare `TypeError`, never a silent no-op. `memoryStorage` provides process-local fallback when `storage.get/set` missing.  
**Key exports:** `Capability` (union), `PATHS`, `NEVER_CALLED`, `detectCapabilities`, `sessionAdapter`, `memoryStorage`, `CapabilityReport`

### `src/probe.ts` — Verify Assignment by Request
**Feature:** Two-attempt probe: `generate.text` (cheap, no session) → session route (heavy, writes history)  
**Purpose:** The catalog is a claim: a model can be listed `active` and still refused at request time. Probe changes no stored state. `ok` and `refused` are real answers; `unverified` means we never got far enough to ask (timeout, missing `generate.text`) — NOT a verdict on the model. Classifies errors: refusal patterns (free-tier) → `refused`; transport faults → `unverified`; else → `refused` (model verdict).  
**Key exports:** `probeAssignments`, `classifyProbeError`, `describeProbe`, `deadRoles`, `suggestPin`, `ProbeResult`, `ProbeVerdict`

### `src/receipts.ts` — Durable Delegation Receipts Across Compaction
**Feature:** `ReceiptStore` with `begin`/`settle`/`noteTranscript`/`reopen`/`injection`/`snapshot`/`restore`  
**Purpose:** A receipt is a pointer, not a transcript. Opened *before* the provider call as `uncertain` (until dispatch returns, nothing is known). `noteTranscript` scans the builder's transcript for the answer (substring match on reply/detail, excluding `RECEIPT_MARKER` to avoid self-consumption). `reopen` fires on compaction hook — the one moment a consumed answer can be lost again. Persists to `ctx.storage` (JSONL); only unconsumed receipts persisted. `injection` formats up to 4 newest pending receipts into a prompt block for the builder. Statuses are `uncertain | delivered | refused | failed` — see `src/outcome.ts` for why `refused` is separate from `failed`. A refusal renders as "the work was never run", not "not a result": the distinction the builder must not lose is between *nothing to find* and *never looked*. `settle` prefers a `status` the dispatcher already decided over re-reading the message, so two records of one dispatch cannot disagree.  
**Key exports:** `ReceiptStore`, `Receipt`, `ReceiptStatus`, `RECEIPT_MARKER`, `noteTranscript`, `reopen`

---

## Evidence & Loop Detection

### `src/evidence.ts` — Verification Evidence Store
**Feature:** Tracks unverified file writes + verification runs; claim extraction + support resolution  
**Purpose:** A model's "done" is a claim. The store watches which files a tool wrote and whether a check ran afterwards. Advisory throughout — nothing blocks/throws over unbacked claims. `record` tracks `WRITE_TOOLS` (edits) → unverified set; `SHELL_TOOLS` with `VERIFY_HINT` (test/build/lint commands) → clears unverified set + increments `verificationRuns`. `recordClaim` accepts claims from handoff envelopes; `resolveSupport` at read time: strongest = `observed` (store saw cited command run after last write), then `referenced` (has `path:line`), else `unbacked` with gap reason. `canRunCommands` derived from agent permissions (not restated).  
**Key exports:** `EvidenceStore`, `recordClaim`, `claimsFromEnvelope`, `describeClaims`, `shellCommand`, `collectPaths`, `resultDigest`, `effectiveToolId`, `EVIDENCE_FILE_CAP`, `EVIDENCE_CLAIM_CAP`

### `src/loop-guard.ts` — Repetition Circuit Breaker
**Feature:** Two circuits (tool + output) with result-aware identity, two thresholds (report at 3, refuse at 5), non-mutating `peek`, `acknowledge` from user message  
**Purpose:** Original bug: counted bare tool names (`read a` → `read b` → `read c` = 3 identical). Fix: identity = `digest(tool + args)`, confirmed only when result present and matches previous confirmed result. Missing result (`undefined`) breaks the run — stops older host from tripping on nothing. `recordTool` pushes identity + outcome; `recordOutput` tracks assistant text (tool-using turn resets); `decide` on `execute.before` refuses at 5 confirmed identical reads (scoped to `read`/`grep`/`glob`). `acknowledge` clears on any user message (includes `/orchestra`, `/checkpoint`, `/panel` via `ctx.session.prompt`). `DELEGATION_TOOLS` shared with `FanoutAdmission`.  
**Key exports:** `RepetitionGuard`, `recordTool`, `recordOutput`, `decide`, `peek`, `acknowledge`, `describeCircuit`, `REFUSAL_TOOLS`, `DELEGATION_TOOLS`, `ToolEvent`, `OutputEvent`, `CircuitVerdict`

---

## Concurrency Control

### `src/fanout.ts` — Multi-Dimension Fan-Out Admission
**Feature:** Three gates (session → model → provider) with reverse-order unwind on refusal; id-less releases; lease-based reap that reaches the waiter queue  
**Purpose:** Permissions gate *which* agent, not how many at once. `FanoutGate` is a waiting room with `acquireTimeoutMs` and `leaseMs`. `FanoutAdmission` chains: session gate → model gate → provider gate. A refusal on one dimension unwinds held slots in reverse through their own gates (no wedge). Id-less launches free exactly one slot per dimension. `providerConcurrency` keyed on `providerID` (not `package`/`baseURL`) for local backends sharing one accelerator/KV pool. A lease reap arms one unref'd timer per queued key, so a waiter behind a *crashed* holder is admitted when the lease lapses instead of reporting a busy limit that had already expired — without it a crashed child cost the builder the full acquire timeout.  
**Key exports:** `FanoutGate`, `FanoutAdmission`, `FanoutOptions`, `Admission`, `FANOUT_DEFAULTS`

---

## Failure Learning & Quarantine

### `src/quarantine.ts` — Failure Classification & Quarantine
**Feature:** Three kinds (`terminal`/`soft`/`rejected`), `REJECTION_PATTERNS` for free-tier, `TRANSPORT_FAULT_PATTERNS` for retry gating  
**Purpose:** Catalog is not truth. Classifies model lifetime, not fault ownership. Terminal (deprecated/not found) → `blocked` immediately. Soft (rate limit) → `blocked` after 3 occurrences. Rejected (free-tier/host-restriction) → **recorded but never `blocked`** — model works in TUI; quarantine is global + 14-day, so blocking would blacklist a working model. `looksLikeTransportFault` gates retries in dispatch (false positive re-runs work; false negative leaves dead model until next re-resolve). `rejectedRefs` used in dispatch skip list; `blockedRefs` in detection exclude list.  
**Key exports:** `classifyFailure`, `recordFailure`, `blockedRefs`, `rejectedRefs`, `describeQuarantine`, `describeRejections`, `pruneRecords`, `isCredentialRefusal`, `looksLikeTransportFault`, `FailureKind`

### `src/failure.ts` — One Failure Classifier
**Feature:** Seven classes (`withdrawn`/`rejected`/`rate_limited`/`transport`/`interrupted`/`unavailable`/`task`), one pattern table per class  
**Purpose:** Three modules used to match overlapping phrases independently and reach different verdicts on the same message. One table is the only place a phrase may be added, and status codes are consulted before prose because they are the structured signal. Classification is kept separate from action: `isWorthRetrying` (walk to another model) and the outcome's `uncertain` (the work was never judged) disagree on purpose, and the corpus in `tests/failure-classes.test.ts` pins where. `task` is a class rather than a shrug, so no caller has to decide what "no verdict" means.  
**Key exports:** `classify`, `isWorthRetrying`, `isCredentialRefusal`, `describeFailure`, `FAILURE_CLASSES`, `FailureClass`, `ErrorLike`

### `src/usage-window.ts` — Reading a Usage Window Out of a Trace
**Feature:** `summarise(text)` over a trace JSONL; `compactionVerdict(window)`  
**Purpose:** The "keep or cut" decisions need a count over real use, and `DispatchTelemetry` is process-local by design, so one `/orchestra` can only ever report on the run that opened it. The trace is the one record that appends *across* restarts. The trap it exists to handle: those counters are **cumulative per process**, so a session reporting three times writes 1, 2, 3 — summing them would inflate the busiest sessions most. The rule is one line per process (its final total), then summed across processes, which is why the plugin stamps `pid` on each telemetry line: without it the only grouping available is the values themselves, and two runs ending on identical totals would merge. `compactionVerdict` returns nothing conclusive when no compaction was recorded, because "zero happened" is not "zero receipts were lost".  
**Key exports:** `summarise`, `compactionVerdict`, `gatesCanBeJudged`, `UsageWindow`, `UsageRun`

**The thin-window guard.** `gatesCanBeJudged` exists because this shipped once with a gate verdict that read "strongest deletion candidate" on a window containing *zero launches* — a gate can only refuse a launch, so a quiet session and a session that never ran produce identical zeros and only one of them is evidence. The aggregation was right and the conclusion drawn from it was not, which is why the guard is a named export rather than an inline comparison: the failure lived in the verdict, not the arithmetic.

`src/modes-types.ts` holds the mode vocabulary and the default on their own, so `prompts.ts` can name `OperatingMode` without importing `modes.ts` — which would be a cycle between the prompt and the policy that shapes it.

### `src/telemetry.ts` — Dispatch Telemetry
**Feature:** In-memory record of every dispatch: role, outcome, elapsed, candidates walked, and gate refusals with their dimension  
**Purpose:** "Keep or cut" decisions need a usage count, and guesses about which code runs are how unused subsystems survive for years. Gate refusals carry `fanoutDimension` on the error, never parsed back out of prose, so a refused fan-out cannot be attributed to the wrong dimension. Compaction re-opens are counted **including the zeros** — a compaction that loses nothing is the evidence a cut of receipt persistence would have to argue against, and counting only successes would make it indistinguishable from a hook that never fires. Deliberately excluded from the prune timer: counters that expire stop being a count.  
**Key exports:** `DispatchTelemetry` (`recordDispatch`, `recordGateRefusal`, `recordProbe`, `recordPanel`, `recordCompaction`, `snapshot`, `reset`), `describeTelemetry`, `GATE_DIMENSIONS`, `TelemetrySnapshot`

**Reading a window:** `scripts/usage-window.ts` prints what these counters add up to across restarts, via `src/usage-window.ts`. Opt-in (`debug: true`) — with tracing off there is no window to read, and an unwritten one is not an empty one.


---

### `src/modes.ts` — Operating Modes
**Feature:** `minimal` / `standard` (default) / `strict`; `MODE_ROLES`, `modeRoleOverrides`  
**Purpose:** A mode is a **structural preset over the role set**, not prompt advice. The tempting version — tell the builder to call the advisor less — saves nothing: the tools are registered either way, so the model may decline the advice and spend the turn regardless, and a cost control the model can talk its way out of is not one. `minimal` sets `advisor`/`skeptic` to `null` in the existing `roles` shape, so those tools are never registered. It deliberately keeps the **scout**: handoff is a core task, so Minimal means "no extra reviewers", never "no delegation". An explicit `roles` entry beats the mode, which is how a dropped role comes back.  
**Known limits, stated rather than faked:** `strict` cannot force a review *before a commit* — nothing observes `git commit` (`agents.ts` only sets `git push *` to `ask`) — so that part is advice, and the prompt says so in those words, because a builder that believes otherwise reports a review it never ran. No mode caps reviewer turns per session. The `subagent` fallback reroutes only to *active* roles, so a removed role is genuinely unreachable.

### `src/outcome.ts` — One Outcome Contract
**Feature:** `OutcomeStatus = 'delivered' | 'refused' | 'uncertain' | 'failed'`, plus `cause` (a `FailureClass`) and `tried`  
**Purpose:** `delegate.ts` said `ok: boolean` and `receipts.ts` said `uncertain | delivered | failed` for the same lifecycle, so answering "did the advisor answer?" meant reading two mappings. The distinction that had no name is `refused`: the provider declined, so the work was never judged — it used to land in `failed`, which told the builder the scout had found nothing. `cause` stays separate because a credential refusal wants a pin and a withdrawn model wants a different one, and `refused` has to remain a small readable set of words. Scope is delegated turns only: `ProbeVerdict` is reachability (an empty body *is* the answer the probe asks for), `RoleAssignment.verification` is that verdict renamed, `ClaimSupport` is support strength, and `CircuitVerdict` is a guard state — none is a view over an outcome.  
**Key exports:** `outcomeFor`, `isDelivered`, `OutcomeStatus`, `Outcome`

---

## Context Awareness

### `src/context.ts` — Context Window Monitor
**Feature:** High-water mark of prompt occupancy across turns; cached reads count as occupancy not cost  
**Purpose:** Host knows each model's real limit; assuming fixed window warns a 1M-token model at a fraction of capacity. Usage from assistant messages (token counts). `observe` folds one request's usage into session estimate; `read` returns `ContextReading` with `occupancy`, `billable`, `ratio`, `warning` (85%), `critical` (95%), `note`. `forget`/`prune` for compaction reset. `occupancyTokens` = uncached + cached + output + reasoning; `billableTokens` = uncached + output + reasoning.  
**Key exports:** `ContextMonitor`, `RequestUsage`, `ContextReading`, `occupancyTokens`, `billableTokens`, `DEFAULT_CONTEXT_LIMIT`, `DEFAULT_WARN_RATIO`

---

## Reporting & Prompts

### `src/report.ts` — Report Rendering
**Feature:** User-facing half of resolver: role table, per-role reasons, runners-up, sharedWith, warnings, quarantined, rejected, session signals, claims, session model mismatch  
**Purpose:** Written to be pasted into a session prompt, so it stays compact. `VERIFICATION_LABEL` distinguishes `verified`/`refused`/`unknown` — the gap that made the failure invisible (table said "detected" for a model that refused every call).  
**Key exports:** `renderReport`, `ReportInput`

### `src/prompts.ts` — System Prompts for Four Roles
**Feature:** Contracts, not personas. Handoff envelope (FINDINGS/FILES/CONFIDENCE/OPEN QUESTIONS) enforced by prompt  
**Purpose:** Scout returns evidence, builder ships, advisor only advises, skeptic only objects. Keeping advisor free of implementation language makes it cheap. Handoff is not completion: consumer may verify. Read-only roles cannot run a check (`docs/roles.md`), so builder holds the only tools that settle one. Skeptic is a role not a mode: disjoint verdict vocabulary (`drop`/`reshape`/`simplify`/`proceed` vs `approve`/`block`), bound to different model wherever catalog allows.  
**Key exports:** `BUILDER_SYSTEM`, `SCOUT_SYSTEM`, `ADVISOR_SYSTEM`, `SKEPTIC_SYSTEM`, `ROLE_SYSTEM`

---

## Agent Definitions

### `src/agents.ts` — Agent Specs + Permissions
**Feature:** Four role specs with ordered-rule permissions (last match wins)  
**Purpose:** `READ_ONLY_PERMISSIONS` (read/glob/grep/webfetch/websearch allow; edit/shell/question/subagent deny + `.env` ask). `BUILDER_PERMISSIONS` (`*:allow` + `external_directory`/`.env`/`git push` ask + `subagent` allow). `roleSpec` copies rules (registry mutates array). `staticAgentBlock` emits plain `opencode.jsonc` agents block. `ON_CALL` = advisor/skeptic (hidden by `hideAdvisor` option).  
**Key exports:** `roleSpec`, `staticAgentBlock`, `PermissionRule`, `RoleSpec`, `BUILDER_PERMISSIONS`, `READ_ONLY_PERMISSIONS`

---

## Persistence & Config

### `src/pin.ts` — Pin File Support
**Feature:** Freezes assignment; read at startup with detection as fallback  
**Purpose:** Detection is live day to day — wrong in CI (provider upgrade silently moves role). Pin file read tolerating missing/malformed. `buildPin` from `ResolveOutput`; `writePin` creates directory; `toJsonc` for pasting into `opencode.jsonc`.  
**Key exports:** `readPin`, `buildPin`, `writePin`, `toJsonc`, `DEFAULT_PIN_PATH`, `PinFile`

### `src/version.ts` — Plugin Version Constant
**Feature:** `PLUGIN_VERSION = '0.1.0'`  
**Purpose:** Kept as constant rather than read from `package.json`: host loads plugin from clone/symlink/global plugin dir, none guarantees resolvable `package.json`. Bump alongside `package.json` on release.

---

## Diagnostics & Contracts

### `src/trace.ts` — Opt-In Delegation Tracing
**Feature:** JSONL file per step (`create`/`move`/`switchAgent`/`switchModel`/`prompt`/`wait`/`context`/`reply`/`failed`)  
**Purpose:** A delegation that produces nothing is indistinguishable from empty answer. Off unless `debug: true`. Synchronous write, errors swallowed — trace must never be the reason a delegation fails. `describeShape` reports key names + value types of transcript (what `extractReply` discriminates on) without reading content.  
**Key exports:** `createFileTrace`, `NO_TRACE`, `Trace`, `TraceEvent`, `describeShape`, `classifyTraceError`

### `src/host-facts.ts` — Compile-Time Host Contract Assertions
**Feature:** Type-level assertions mapped to `docs/host-behavior.md` rows (H1–H13)  
**Purpose:** If SDK moves, this file (running inside `bun run typecheck`) breaks loudly instead of letting the mirror in `plugin-types.ts` drift silently. Uses `import type` only — no runtime dependency. `tests/host-facts-doc.test.ts` asserts this module is never imported at runtime.  
**Key assertions:** AgentEditor has no `add`; `default()` returns void; ToolEditor has `add`; Registry model is `{id, providerID, variant?}` not config shape; Context event has no `kind`; Compaction event has sessionID; Retry event has `attempt`; Tool hooks have `id` and `agent`.

### `src/plugin-types.ts` — Structural Mirror of `@opencode/plugin`
**Feature:** Declared here so plugin loads with zero installed dependencies  
**Purpose:** Host only reads default export's `id` and `setup`, so a plain object is a valid plugin. Install `@opencode/plugin` to type-check entrypoint against real contract. Defines `PluginContextLike`, `AgentEditorLike`, `ModelEditorLike`, `ToolEditorLike`, `CommandInvocationLike`, `ToolHookEventLike` (with `result`/`error` for H13), `ContextHookEventLike`, `RetryHookEventLike`, `CompactionHookEventLike`, `CommandDefinitionLike`, `PluginDefinitionLike`.

---

## Testing

### `src/selftest.ts` — Resolver + Signal Fixtures
**Feature:** Fixture-driven checks for resolver invariants + runtime signals (evidence, loop-guard, context, fan-out)  
**Purpose:** Detection cannot be verified by reading code — depends on whatever catalog host exposes. Runs resolver over fixed catalogs and asserts invariants so weight/heuristic changes cannot silently mis-role a model. 21 resolver fixtures + 36 signal fixtures. Run via `/orchestra-selftest` (enable `selftest` in plugin options).  
**Key exports:** `runSelfTest`, `SelfTestResult`, `FIXTURES`, `SIGNAL_FIXTURES`

---

## Plugin Entry

### `plugin/index.ts` — Main Entry (not in src/)
**Feature:** Setup, option parsing, capability detection, role resolution, hook registration, command registration  
**Purpose:** Owns the wiring, not the model list. At load: asks OpenCode which models this project has, scores them, registers each with a winner. Registers: session-backed `orchestra_scout`/`orchestra_advisor`/`orchestra_skeptic` tools; `orchestra`/`orchestra-probe`/`orchestra-checkpoint`/`orchestra-panel`/`orchestra-pin`/`orchestra-recheck` commands; hooks: `session.hook('context')` (evidence + receipts + loop-guard output/acknowledge + context pressure), `session.hook('compaction')` (receipt reopen), `session.hook('retry')` (quarantine), `tool.hook('execute.before')` (fan-out admission + loop-guard refusal), `tool.hook('execute.after')` (evidence + fan-out release), `tool.transform` (registers delegation tools). `apply()` re-registers agents on detection change.