/**
 * opencode-orchestra — hierarchical advisor-mode agents with live model detection.
 *
 * The plugin owns the wiring, not the model list. At load it asks OpenCode which
 * models are actually available for this project, scores them for the three
 * roles, and registers `builder`, `scout` and `advisor` with the winning model
 * and reasoning variant attached. Provider upgrades therefore re-role the team
 * without editing a config file.
 *
 * Load it from `opencode.jsonc`:
 *
 *   { "plugins": [{ "package": "./plugin", "options": { "defaultAgent": true } }] }
 */

import { isAbsolute, resolve as resolvePath } from "node:path"
import { roleSpec, staticAgentBlock } from "../src/agents"
import { ContextMonitor } from "../src/context"
import type { RequestUsage } from "../src/context"
import { FanoutGate, FANOUT_DEFAULTS } from "../src/fanout"
import { effectiveToolId, EvidenceStore } from "../src/evidence"
import { describeCircuit, RepetitionGuard } from "../src/loop-guard"
import { buildPin, DEFAULT_PIN_PATH, readPin, toJsonc, writePin } from "../src/pin"
import { ADVISOR_SYSTEM } from "../src/prompts"
import { renderReport } from "../src/report"
import { blockedRefs, describeQuarantine, pruneRecords, recordFailure } from "../src/quarantine"
import { resolveRoles } from "../src/roles"
import { runSelfTest } from "../src/selftest"
import { ROLES } from "../src/types"
import type { ModelRef, ResolveOutput, RoleName } from "../src/types"
import type { FailureRecord } from "../src/quarantine"
import type { TokenUsageLike } from "../src/plugin-types"
import type { AgentEditorLike, CommandInvocationLike, ModelEditorLike, PluginContextLike } from "../src/plugin-types"

export interface OrchestraOptions {
  /** Set to false to keep the plugin loaded but inert. */
  enabled?: boolean
  /** Pin file path relative to the project, or false to ignore pinning. */
  pin?: string | false
  /** Force a role onto a model: `{ "advisor": "anthropic/claude-opus-4-1" }`. */
  roles?: Partial<Record<RoleName, string | null>>
  /** Force a reasoning variant: `{ "scout": "low", "advisor": "high" }`. */
  variants?: Partial<Record<RoleName, string | null>>
  /** Keep the advisor out of `@`-mention listings. */
  hideAdvisor?: boolean
  /** Step ceilings per role. */
  steps?: Partial<Record<RoleName, number>>
  /** Make `builder` the default primary agent. Off by default. */
  defaultAgent?: boolean
  /**
   * Make new sessions start on the detected builder model.
   *
   * A session keeps its own model selection, and that selection wins over an
   * agent's `model`. Without this, a session with no explicit `model` falls back
   * to the newest catalog entry rather than the model the builder was given.
   * Off by default so an explicit `model` in your config is never overridden.
   */
  defaultModel?: boolean
  /** Register the slash commands. On by default. */
  commands?: boolean
  /** Register `/orchestra-selftest`, which checks the resolver on fixed catalogs. */
  selftest?: boolean
  /**
   * Track files changed since the last verification run and say so in reports.
   * On by default.
   */
  evidence?: boolean
  /**
   * Trip a circuit on repeated identical tool calls or identical tool-free
   * turns. On by default.
   */
  loopGuard?: boolean
  /**
   * Warn the builder when a session approaches its model's real context limit.
   * On by default.
   */
  context?: boolean
  /** Fraction of the context window at which to warn. */
  contextWarnRatio?: number
  /** Override the context window for every model. */
  contextMaxTokens?: number
  /**
   * Maximum concurrent subagent launches per session. Excess launches queue
   * rather than fail. 0 disables the gate. Default 2.
   */
  maxConcurrentSubagents?: number
  /** How long a launch waits for a slot before it is refused. Default 120s. */
  fanoutWaitMs?: number
  /**
   * Learn from provider failures: drop a model from detection once it returns a
   * terminal error, or after repeated rate limits. On by default.
   */
  quarantine?: boolean
}

type Applied = "created" | "model-only" | "skipped"
type AppliedMap = Partial<Record<RoleName, Applied>>

interface SessionSignals {
  evidence?: string
  context?: string
}

const RETRY_DELAYS = [250, 500, 1000, 2000, 4000, 8000]
const QUARANTINE_KEY = "quarantine"
/** Forget failures older than this so a recovered model can come back. */
const QUARANTINE_TTL = 14 * 24 * 60 * 60 * 1000

function parseOptions(raw: Record<string, unknown>): OrchestraOptions {
  const options = raw ?? {}
  return {
    enabled: options.enabled === undefined ? true : options.enabled === true,
    pin: options.pin === false ? false : typeof options.pin === "string" ? options.pin : DEFAULT_PIN_PATH,
    roles: (options.roles ?? {}) as OrchestraOptions["roles"],
    variants: (options.variants ?? {}) as OrchestraOptions["variants"],
    hideAdvisor: options.hideAdvisor === true,
    steps: (options.steps ?? {}) as OrchestraOptions["steps"],
    defaultAgent: options.defaultAgent === true,
    defaultModel: options.defaultModel === true,
    commands: options.commands === undefined ? true : options.commands !== false,
    selftest: options.selftest === true,
    quarantine: options.quarantine === undefined ? true : options.quarantine !== false,
    evidence: options.evidence === undefined ? true : options.evidence !== false,
    loopGuard: options.loopGuard === undefined ? true : options.loopGuard !== false,
    context: options.context === undefined ? true : options.context !== false,
    contextWarnRatio: typeof options.contextWarnRatio === "number" ? options.contextWarnRatio : undefined,
    contextMaxTokens:
      typeof options.contextMaxTokens === "number" && options.contextMaxTokens > 0
        ? options.contextMaxTokens
        : undefined,
    maxConcurrentSubagents:
      typeof options.maxConcurrentSubagents === "number" && options.maxConcurrentSubagents >= 0
        ? Math.floor(options.maxConcurrentSubagents)
        : undefined,
    fanoutWaitMs:
      typeof options.fanoutWaitMs === "number" && options.fanoutWaitMs > 0
        ? options.fanoutWaitMs
        : undefined,
  }
}

function pinLocation(root: string, pin: OrchestraOptions["pin"]): string | null {
  if (!pin) return null
  return isAbsolute(pin) ? pin : resolvePath(root, pin)
}

/**
 * Prompt occupancy implied by the newest request that reported usage.
 *
 * For one request, `input + cache.read` is the whole prompt: the uncached part
 * plus the part served from cache. Both are resident in the window, which is why
 * occupancy counts them together. Summing across turns would multiply-count the
 * transcript, so exactly one turn is read — and the monitor keeps the high-water
 * mark, because later turns in a session are mostly cache hits.
 */
function usageFromMessages(messages: readonly unknown[]): RequestUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const tokens = (messages[index] as { tokens?: TokenUsageLike })?.tokens
    if (tokens) return tokens
  }
  return undefined
}

function applyVariantOverrides(resolved: ResolveOutput, variants: OrchestraOptions["variants"]): void {
  if (!variants) return
  for (const role of ROLES) {
    const forced = variants[role]
    const assignment = resolved.assignments[role]
    if (!assignment?.model) continue
    if (forced === null) delete assignment.model.variant
    else if (typeof forced === "string") assignment.model.variant = forced
  }
}

export default {
  id: "opencode-orchestra",

  async setup(ctx: PluginContextLike) {
    const options = parseOptions(ctx.options)
    if (!options.enabled) return

    const root = ctx.location.directory
    const pinPath = pinLocation(root, options.pin)
    const pinFile = pinPath ? readPin(pinPath) : null

    const activeRoles = ROLES.filter((role) => options.roles?.[role] !== null)
    const state = {
      resolved: undefined as ResolveOutput | undefined,
      applied: {} as AppliedMap,
      pinPath,
      pinStatus: pinFile
        ? `read (updated ${pinFile.updated ?? "unknown"})`
        : pinPath
          ? "not found, using live detection"
          : "disabled",
      catalogSize: 0,
      sessionDefault: undefined as string | undefined,
      quarantine: [] as string[],
    }
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const disposables: { dispose(): Promise<void> }[] = []
    let registration: { dispose(): Promise<void> } | undefined
    let modelRegistration: { dispose(): Promise<void> } | undefined
    let failures: Record<string, FailureRecord> = {}

    const evidence = new EvidenceStore()
    const loopGuard = new RepetitionGuard()
    const context = new ContextMonitor({
      warnRatio: options.contextWarnRatio,
      overrideMaxTokens: options.contextMaxTokens,
    })
    /** Per-session signals, surfaced by the report and by `/checkpoint`. */
    const sessionState = new Map<string, SessionSignals>()

    async function detect(): Promise<ResolveOutput> {
      const catalog = (await ctx.model.list()).data ?? []
      state.catalogSize = catalog.length
      if (options.context !== false) {
        // The catalog carries each model's real window; use it instead of a
        // fixed assumption, so a 1M model is not judged against 200k.
        context.seed(
          catalog
            .filter((model) => model.limit?.context)
            .map((model) => ({ ref: `${model.providerID}/${model.id}`, context: model.limit?.context })),
        )
      }
      const resolved = resolveRoles({
        catalog,
        overrides: options.roles,
        pins: pinFile?.roles,
        exclude: blockedRefs(failures),
      })
      applyVariantOverrides(resolved, options.variants)
      return resolved
    }

    /**
     * Points the session default at the builder's model. A session's model
     * selection takes precedence over an agent's, so without this the builder
     * runs on whatever OpenCode picked as the catalog default.
     */
    async function applyDefaultModel(resolved: ResolveOutput): Promise<void> {
      const builder = resolved.assignments.builder?.model
      if (!options.defaultModel || !builder) return
      await modelRegistration?.dispose()
      modelRegistration = await ctx.model.transform((editor: ModelEditorLike) => {
        editor.default.set(builder.providerID, builder.id)
      })
      state.sessionDefault = `${builder.providerID}/${builder.id}`
    }

    /** Registers (or re-registers) the agent transform for the current picks. */
    async function apply(attempt = 0): Promise<void> {
      const resolved = await detect()
      state.resolved = resolved

      if (!resolved.candidates.length && attempt < RETRY_DELAYS.length) {
        // Provider availability settles after plugin load; retry before giving up.
        const timer = setTimeout(() => {
          timers.delete(timer)
          void apply(attempt + 1)
        }, RETRY_DELAYS[attempt])
        timers.add(timer)
        return
      }

      await registration?.dispose()
      const applied: AppliedMap = {}
      registration = await ctx.agent.transform((editor: AgentEditorLike) => {
        for (const role of activeRoles) {
          const spec = roleSpec(role, { hideAdvisor: options.hideAdvisor, steps: options.steps })
          const assignment = resolved.assignments[role]
          const model = assignment?.model
          const existing = editor.get(role)
          if (existing) {
            // The project already defines this agent, so keep its prompt and
            // permissions and only retarget the model at what is available now.
            editor.update(role, (agent) => {
              if (model) agent.model = model
              if (spec.steps) agent.steps = spec.steps
            })
            applied[role] = model ? "model-only" : "skipped"
            continue
          }
          editor.update(role, (agent) => {
            agent.name = spec.name
            agent.description = spec.description
            agent.mode = spec.mode
            agent.hidden = spec.hidden
            agent.color = spec.color
            agent.system = spec.system
            agent.permissions = spec.permissions
            if (model) agent.model = model
            if (spec.steps) agent.steps = spec.steps
          })
          applied[role] = "created"
        }
        if (options.defaultAgent && editor.get("builder")) editor.default("builder")
      })
      state.applied = applied
      await applyDefaultModel(resolved)
    }

    await apply()

    /**
     * Learns from provider failures. The catalog can list a model as active
     * while the provider has withdrawn it, so a role that keeps failing is taken
     * out of detection and the team is re-roled immediately. Rate limits are
     * counted first, because one busy minute should not cost us a model.
     */
    if (options.quarantine !== false) {
      const stored = (await ctx.storage.get(QUARANTINE_KEY)) as Record<string, FailureRecord> | undefined
      failures = pruneRecords(stored ?? {}, Date.now() - QUARANTINE_TTL)
      if (Object.keys(failures).length) {
        state.quarantine = describeQuarantine(failures)
        await apply()
      }

      const retryRegistration = await ctx.session.hook("retry", (event) => {
        const ref = `${event.model.providerID}/${event.model.id}`
        const result = recordFailure(failures, ref, event.error, Date.now())
        if (result.kind === "ignore") return
        failures = result.records
        void ctx.storage.set(QUARANTINE_KEY, failures)
        if (!result.changed) return
        state.quarantine = describeQuarantine(failures)
        // The model that just failed may be holding a role; re-pick without it.
        void apply().catch(() => undefined)
      })
      disposables.push(retryRegistration)
    }

    /**
     * Evidence. A model's "done" is a claim; this records which files it wrote
     * and whether a verification command has run since. Nothing is enforced —
     * the signal is surfaced in the report and injected into the builder's
     * system prompt, because a plugin cannot decide whether code is correct.
     */
    if (options.evidence !== false) {
      disposables.push(
        await ctx.tool.hook("execute.after", (event) => {
          const tool = effectiveToolId(event.tool)
          evidence.record(event.sessionID, tool, event.input, event.status)
          if (options.loopGuard !== false) loopGuard.recordTool({ sessionID: event.sessionID, tool })
          const signals = sessionState.get(event.sessionID) ?? {}
          signals.evidence = evidence.describe(event.sessionID)
          sessionState.set(event.sessionID, signals)
        }),
      )
    }

    /**
     * Fan-out admission. A session's model selection does not bound how many
     * subagents the builder launches in one message, and each launch is a
     * provider request, so an unbounded fan-out is a reliable way to hit a rate
     * limit. The `subagent` permission action can only gate *which* agent runs,
     * never how many at once, so the count is enforced here, before dispatch.
     *
     * Excess launches wait for a slot rather than failing: a model that asked for
     * four searches and was refused will usually drop three of them. The hook is
     * genuinely awaited, so waiting here is indistinguishable from a slow tool.
     */
    const fanout = new FanoutGate({
      limit: options.maxConcurrentSubagents,
      acquireTimeoutMs: options.fanoutWaitMs,
    })
    const fanoutLimit = options.maxConcurrentSubagents === 0 ? 0 : (options.maxConcurrentSubagents ?? FANOUT_DEFAULTS.limit)
    /** Host tool-call id → the slot it holds, so a completion frees exactly one. */
    const slotByCall = new Map<string, { sessionID: string; slotId: string }>()

    async function admitFanout(event: { sessionID: string; id?: string; input: unknown }): Promise<void> {
      if (fanoutLimit === 0) return
      const agent = (event.input as { agent?: string } | undefined)?.agent
      const admission = await fanout.acquire(event.sessionID, agent)
      if (!admission.ok) {
        // Throwing here blocks the call and hands the reason back to the model.
        throw new Error(`orchestra: ${admission.refused}`)
      }
      if (event.id && admission.slotId) {
        slotByCall.set(event.id, { sessionID: event.sessionID, slotId: admission.slotId })
      }
    }

    function releaseFanout(event: { sessionID: string; id?: string }): void {
      if (fanoutLimit === 0 || !event.id) return
      const held = slotByCall.get(event.id)
      if (!held) return
      slotByCall.delete(event.id)
      fanout.release(held.sessionID, held.slotId)
    }

    if (fanoutLimit > 0) {
      disposables.push(
        await ctx.tool.hook("execute.before", async (event) => {
          if (effectiveToolId(event.tool) !== "subagent") return
          await admitFanout(event)
        }),
      )
      // Registered separately from the evidence hook so that turning evidence off
      // cannot leave subagent slots held forever.
      disposables.push(
        await ctx.tool.hook("execute.after", (event) => {
          releaseFanout(event)
        }),
      )
    }

    /**
     * Context pressure. Uses each model's real window from the catalog, so a
     * 1M-token model is judged against 1M rather than a hardcoded default.
     */
    /** Sessions with a usage read in flight, so one turn makes at most one call. */
    const pendingUsage = new Set<string>()

    if (options.context !== false) {
      disposables.push(
        await ctx.session.hook("context", (event) => {
          // This hook carries no `kind` field, verified against the running host:
          // filtering on `kind === "primary"` silently discarded every event. A
          // session has one primary loop, so treat any event as the main one.
          context.rememberModel(event.sessionID, event.model.providerID, event.model.id)
          // The hook's `messages` are the outgoing transcript and carry no token
          // counts, so usage comes from the session record. That is an extra read
          // per turn, which is why it is deferred rather than done inline: a hook
          // must not add latency to the request it is decorating. The guard keeps
          // it to one call in flight per session.
          if (pendingUsage.has(event.sessionID)) return
          pendingUsage.add(event.sessionID)
          void ctx.session
            .context({ sessionID: event.sessionID })
            .then((messages) => {
              const usage = usageFromMessages(messages)
              if (!usage) return
              const reading = context.observe(event.sessionID, usage)
              const signals = sessionState.get(event.sessionID) ?? {}
              signals.context = reading.warning ? reading.note : undefined
              sessionState.set(event.sessionID, signals)
            })
            .catch(() => undefined)
            .finally(() => pendingUsage.delete(event.sessionID))
        }),
      )
    }

    /**
     * Re-reads pressure for the report. The estimate is maintained from the
     * request hook; this only refreshes the wording and never estimates.
     */
    function refreshContextNote(sessionID: string): void {
      if (options.context === false) return
      const reading = context.read(sessionID)
      const signals = sessionState.get(sessionID) ?? {}
      signals.context = reading.warning ? reading.note : undefined
      sessionState.set(sessionID, signals)
    }

    /** Keeps per-session maps from growing without bound. */
    const pruneTimer = setInterval(() => {
      evidence.prune()
      loopGuard.prune()
      // Only drop bookkeeping for sessions with nothing in flight. Clearing the
      // gate wholesale would free live slots and let a slow child push the
      // session over its own limit.
      for (const [callID, held] of [...slotByCall]) {
        if (fanout.inFlight(held.sessionID) === 0) slotByCall.delete(callID)
      }
    }, 5 * 60_000)
    timers.add(pruneTimer as unknown as ReturnType<typeof setTimeout>)

    if (!options.commands) {
      return () => {
        for (const timer of timers) clearTimeout(timer)
        fanout.reset("the plugin unloaded")
        for (const item of disposables) void item.dispose()
        void registration?.dispose()
      }
    }

    const send = async (input: CommandInvocationLike, text: string) => {
      await ctx.session.prompt({
        ...input.prompt,
        sessionID: input.sessionID,
        text,
        delivery: input.delivery ?? "steer",
      })
    }

    const pinLabel = (path: string | null) => (path && path.startsWith(root + "/") ? path.slice(root.length + 1) : path)

    const report = async (verbose = false, input?: CommandInvocationLike) => {
      const sessionDefault = await ctx.model
        .default()
        .then((result) => {
          const model = result?.data
          return model ? `${model.providerID}/${model.id}` : undefined
        })
        .catch(() => undefined)
      return renderReport({
        resolved: state.resolved!,
        applied: state.applied,
        pinPath: pinLabel(state.pinPath) ?? DEFAULT_PIN_PATH,
        pinStatus: state.pinStatus,
        verbose,
        sessionDefault,
        defaultModelEnabled: options.defaultModel,
        quarantine: state.quarantine,
        signals: input ? signalsFor(input.sessionID) : undefined,
      })
    }

    /** Live per-session signals, with context pressure re-read at report time. */
    function signalsFor(sessionID: string) {
      refreshContextNote(sessionID)
      const signals = sessionState.get(sessionID)
      if (!signals) return undefined
      const entries: string[] = []
      if (signals.evidence) entries.push(signals.evidence)
      // Peek rather than reuse the verdict cached at trip time: the circuit may
      // have auto-cleared since, and a stale "auto-clears in 30s" is worse than
      // no line at all.
      const circuit = loopGuard.peek(sessionID)
      if (circuit.open) entries.push(describeCircuit(circuit))
      if (signals.context) entries.push(signals.context)
      return entries.length ? entries : undefined
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "orchestra",
        description: "Show which models the orchestra picked for builder, scout and advisor, and why.",
        execute: async (input) => {
          const argument = input.prompt?.text ?? ""
          if (/\b(recheck|refresh|redo)\b/i.test(argument)) {
            await apply()
            state.pinStatus = pinFile
              ? `read (updated ${pinFile.updated ?? "unknown"}); re-detected ${state.catalogSize} models`
              : `not found, using live detection (${state.catalogSize} models)`
          }
          await send(
            input,
            [
              "Report the orchestra assignment below to the user.",
              "Keep it short: the table is the answer. Then note only roles that look wrong for this project and, if so, the exact pin line that would fix them.",
              "",
              await report(/\b(all|verbose|debug)\b/i.test(argument), input),
            ].join("\n"),
          )
        },
      })

      editor.add({
        name: "orchestra-pin",
        description: "Freeze the current model assignment into the orchestra pin file.",
        execute: async (input) => {
          await apply()
          if (!state.pinPath) {
            await send(input, "Pinning is disabled in this project's plugin options.")
            return
          }
          if (!state.resolved?.candidates.length) {
            await send(input, "No tool-capable model is available here, so there is nothing to pin yet.")
            return
          }
          const pin = buildPin(state.resolved, state.catalogSize, activeRoles)
          writePin(state.pinPath, pin)
          state.pinStatus = `written (${pin.updated})`
          const specs = activeRoles.map((role) => roleSpec(role, { hideAdvisor: options.hideAdvisor, steps: options.steps }))
          const models = Object.fromEntries(
            activeRoles.map((role) => [role, state.resolved!.assignments[role]!.model]),
          ) as Record<RoleName, ModelRef | undefined>
          await send(
            input,
            [
              `Wrote the pin file \`${pinLabel(state.pinPath!)}\`.`,
              "",
              await report(false, input),
              "",
              "To move a role off live detection permanently, add an `agents` block to `opencode.jsonc`:",
              "",
              "```jsonc",
              toJsonc({ agents: staticAgentBlock(specs, models) }),
              "```",
            ].join("\n"),
          )
        },
      })

      editor.add({
        name: "checkpoint",
        description: "Ask the advisor (strong reasoning model) for a verdict before continuing.",
        execute: async (input) => {
          const signals = signalsFor(input.sessionID)
          await send(
            input,
            [
              "Run an advisor checkpoint before going further.",
              "",
              "1. Launch the `advisor` subagent. Give it what it needs to judge: the current plan or diff, the failing command output if something is failing, and one explicit question.",
              ...(signals?.length ? ["", "Runtime signals to include:", ...signals.map((entry) => `- ${entry}`)] : []),
              "2. Relay the verdict (`approve`, `approve with notes`, `block`) back to the user in at most three lines.",
              "3. If the verdict is `block`, do not keep implementing until you have addressed the finding or explained why it does not apply.",
              "",
              `Advisor contract to enforce:\n${ADVISOR_SYSTEM}`,
            ].join("\n"),
          )
        },
      })

      if (options.selftest) {
        editor.add({
          name: "orchestra-selftest",
          description: "Check the role resolver against fixed catalogs.",
          execute: async (input) => {
            const result = await runSelfTest()
            await send(
              input,
              [
                result.failed === 0
                  ? `Self-test passed: ${result.passed} fixtures. Report this in one line and stop.`
                  : `Self-test FAILED: ${result.failed} of ${result.passed + result.failed} fixtures. Report the failures verbatim and do not investigate them.`,
                "",
                "```",
                ...result.lines,
                "```",
              ].join("\n"),
            )
          },
        })
      }
    })

    return () => {
      for (const timer of timers) clearTimeout(timer)
      for (const item of disposables) void item.dispose()
      fanout.reset("the plugin unloaded")
      void registration?.dispose()
      void modelRegistration?.dispose()
    }
  },
}