/**
 * opencode-orchestra — hierarchical advisor-mode agents with live model detection.
 *
 * Owns the wiring, not the model list: at load it asks OpenCode which models this
 * project actually has, scores them for the three roles, and registers each with
 * a winner. Load from `opencode.jsonc` as
 * `{ "plugins": [{ "package": "./plugin", "options": { "defaultAgent": true } }] }`.
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import { agentModel, roleSpec, staticAgentBlock } from '../src/agents'
import type { Capability } from '../src/capabilities'
import { detectCapabilities, memoryStorage, sessionAdapter } from '../src/capabilities'
import type { RequestUsage } from '../src/context'
import { ContextMonitor } from '../src/context'
import type { DelegationResult } from '../src/delegate'
import { delegateToAgent } from '../src/delegate'
import { claimsFromEnvelope, EvidenceStore, effectiveToolId, resultDigest } from '../src/evidence'
import { FANOUT_DEFAULTS, FanoutAdmission } from '../src/fanout'
import { DELEGATION_TOOLS, describeCircuit, REFUSAL_TOOLS, RepetitionGuard } from '../src/loop-guard'
import { modeRoleOverrides } from '../src/modes'
import { DEFAULT_MODE, isOperatingMode, OPERATING_MODES, type OperatingMode } from '../src/modes-types'
import { buildPin, DEFAULT_PIN_PATH, readPin, toJsonc, writePin } from '../src/pin'
import type {
  AgentEditorLike,
  CommandInvocationLike,
  ModelEditorLike,
  PluginContextLike,
  TokenUsageLike
} from '../src/plugin-types'
import { deadRoles, describeProbe, probeAssignments, suggestPin } from '../src/probe'
import { ADVISOR_SYSTEM } from '../src/prompts'
import type { FailureRecord } from '../src/quarantine'
import {
  blockedRefs,
  describeQuarantine,
  describeRejections,
  isCredentialRefusal,
  looksLikeTransportFault,
  pruneRecords,
  recordFailure,
  rejectedRefs
} from '../src/quarantine'
import type { ReceiptSnapshot } from '../src/receipts'
import { ReceiptStore } from '../src/receipts'
import { renderReport } from '../src/report'
import type { RankedCandidate, ResolvedRoles } from '../src/roles'
import { fallbackChain, resolveRoles } from '../src/roles'
import { runSelfTest } from '../src/selftest'
import { DispatchTelemetry, describeTelemetry, type GateDimension } from '../src/telemetry'
import { createFileTrace, DEFAULT_TRACE_PATH } from '../src/trace'
import type { FileRef, ModelRef, RoleName } from '../src/types'
import { HANDOFF_LIMITS, ROLES } from '../src/types'
import { PLUGIN_VERSION } from '../src/version'

export interface OrchestraOptions {
  /** Set to false to keep the plugin loaded but inert. */
  enabled?: boolean
  /** Pin file path relative to the project, or false to ignore pinning. */
  pin?: string | false
  /** Force a role onto a model: `{ "advisor": "anthropic/claude-opus-4-1" }`. */
  roles?: Partial<Record<RoleName, string | null>>
  /**
   * Operating mode: `minimal` (no reviewers), `standard` (default), `strict`.
   *
   * Applies to the role set structurally — a role a mode removes is never
   * registered, so its tool cannot become a delegation — and an explicit `roles`
   * entry overrides it, including re-enabling a role the mode drops.
   */
  mode?: string
  /** Force a reasoning variant: `{ "scout": "low", "advisor": "high" }`. */
  variants?: Partial<Record<RoleName, string | null>>
  /** Keep the advisor out of `@`-mention listings. */
  hideAdvisor?: boolean
  /** Step ceilings per role. */
  steps?: Partial<Record<RoleName, number>>
  /** Make `builder` the default primary agent. Off by default. */
  defaultAgent?: boolean
  /**
   * Make new sessions start on the detected builder model. Off by default so an
   * explicit `model` in your config is never overridden — a session's own
   * selection beats an agent's `model`.
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
  /** Keep a receipt per delegation and re-offer unconsumed ones after compaction. */
  receipts?: boolean
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
   * Concurrent launches against a single model, across sessions. `0` or absent
   * disables the cap. The session limit bounds one caller; this bounds what one
   * backend absorbs, which two sessions can exceed together.
   */
  maxConcurrentPerModel?: number
  /**
   * Concurrent launches against one provider runtime, across sessions and
   * models — for a local backend that is one accelerator with one KV pool.
   * `{ "ollama": 1 }` lets a single local child run at a time. Providers not
   * named here are unbounded. Keyed on `providerID`.
   */
  providerConcurrency?: Record<string, number>
  /** Per-model budget for `/orchestra probe`. Default 20s. */
  probeTimeoutMs?: number
  /** Register the session-backed `scout` / `advisor` tools. Off leaves only the host's own. */
  sessionDelegate?: boolean
  /**
   * Retry a host `subagent` launch the credential refuses over an ordinary session. On by default;
   * the native launch still runs first and keeps working wherever it is permitted.
   */
  subagentFallback?: boolean
  /**
   * Budget for one delegated turn, end to end. Default 300s, because a real
   * agent turn involves a full model call plus tool use.
   */
  delegateTimeoutMs?: number
  /**
   * Trace every session-backed delegation to a JSONL file: which step ran, how
   * long it took, and the SHAPE of the transcript the host returned. Off by
   * default, because a plugin should not write files unasked.
   *
   * Shapes only — key names and value types, never message text. A proposal and
   * two review verdicts are not worth a log line; the disagreement between what
   * `extractReply` expects and what `session.context()` returns is.
   */
  debug?: boolean
  /** Where that trace goes. Default `.opencode/orchestra-debug.jsonl`. */
  tracePath?: string
  /**
   * Learn from provider failures: drop a model from detection once it returns a
   * terminal error, or after repeated rate limits. On by default.
   */
  quarantine?: boolean
}

type Applied = 'created' | 'model-only' | 'skipped'
type AppliedMap = Partial<Record<RoleName, Applied>>

interface SessionSignals {
  evidence?: string
  context?: string
}

/** One delegated dispatch, and what it cost. A role that silently moved answers identically to one that did not. */
interface DispatchNote {
  role: RoleName
  /** Refs actually dispatched on, in order. One entry means no retry fired. */
  tried: string[]
  /** True when the failure moved the role onto another candidate. */
  retried: boolean
  /** Why the walk stopped where it did, in the caller's terms. */
  why: string
}

/** Dispatch history is bounded: the newest few are what explain a report. */
const DISPATCH_HISTORY = 10

const RETRY_DELAYS = [250, 500, 1000, 2000, 4000, 8000]

const QUARANTINE_KEY = 'quarantine'
/** Forget failures older than this so a recovered model can come back. */
const QUARANTINE_TTL = 14 * 24 * 60 * 60 * 1000

/**
 * Where unconsumed receipts are kept across a restart. Its own key: a receipt is
 * a per-session claim about one dispatch, and the quarantine record is a global,
 * two-week history of models.
 */
const RECEIPT_KEY = 'receipts'

/**
 * Options as resolved, with the mode decided.
 *
 * Separate from `OrchestraOptions` because the public type has to accept a
 * `string` there — a config file is untyped input, and a union that only admits
 * the three real modes would make every caller in the codebase guard it and
 * nothing check it at runtime, which is the arrangement that lets a typo
 * through.
 */
export interface ResolvedOptions extends OrchestraOptions {
  mode: OperatingMode
  modeWasUnrecognised: boolean
}

function parseOptions(raw: Record<string, unknown>): ResolvedOptions {
  const options = raw ?? {}
  return {
    enabled: options.enabled === undefined ? true : options.enabled === true,
    pin: options.pin === false ? false : typeof options.pin === 'string' ? options.pin : DEFAULT_PIN_PATH,
    roles: (options.roles ?? {}) as OrchestraOptions['roles'],
    variants: (options.variants ?? {}) as OrchestraOptions['variants'],
    hideAdvisor: options.hideAdvisor === true,
    // An unrecognised mode falls back to standard rather than failing to load:
    // a typo in a config file should not stop the plugin, and the fallback is
    // reported so "my setting did nothing" is never silent.
    mode: isOperatingMode(options.mode) ? options.mode : DEFAULT_MODE,
    modeWasUnrecognised: options.mode !== undefined && !isOperatingMode(options.mode),
    steps: (options.steps ?? {}) as OrchestraOptions['steps'],
    defaultAgent: options.defaultAgent === true,
    defaultModel: options.defaultModel === true,
    commands: options.commands === undefined ? true : options.commands !== false,
    selftest: options.selftest === true,
    quarantine: options.quarantine === undefined ? true : options.quarantine !== false,
    evidence: options.evidence === undefined ? true : options.evidence !== false,
    loopGuard: options.loopGuard === undefined ? true : options.loopGuard !== false,
    context: options.context === undefined ? true : options.context !== false,
    receipts: options.receipts === undefined ? true : options.receipts !== false,
    // Was read at the wrapper below but never assigned here, so the option was
    // always `undefined` and `!== false` was always true: the documented escape
    // hatch could not be reached. The default is on, so only an explicit `false`
    // means anything.
    subagentFallback: options.subagentFallback === undefined ? true : options.subagentFallback !== false,
    debug: options.debug === true,
    tracePath: typeof options.tracePath === 'string' ? options.tracePath : DEFAULT_TRACE_PATH,
    contextWarnRatio: typeof options.contextWarnRatio === 'number' ? options.contextWarnRatio : undefined,
    contextMaxTokens:
      typeof options.contextMaxTokens === 'number' && options.contextMaxTokens > 0
        ? options.contextMaxTokens
        : undefined,
    maxConcurrentSubagents:
      typeof options.maxConcurrentSubagents === 'number' && options.maxConcurrentSubagents >= 0
        ? Math.floor(options.maxConcurrentSubagents)
        : undefined,
    fanoutWaitMs:
      typeof options.fanoutWaitMs === 'number' && options.fanoutWaitMs > 0 ? options.fanoutWaitMs : undefined,
    maxConcurrentPerModel:
      typeof options.maxConcurrentPerModel === 'number' && options.maxConcurrentPerModel >= 0
        ? Math.floor(options.maxConcurrentPerModel)
        : undefined,
    providerConcurrency: parseProviderConcurrency(options.providerConcurrency),
    probeTimeoutMs:
      typeof options.probeTimeoutMs === 'number' && options.probeTimeoutMs > 0 ? options.probeTimeoutMs : undefined,
    sessionDelegate: options.sessionDelegate !== false,
    delegateTimeoutMs:
      typeof options.delegateTimeoutMs === 'number' && options.delegateTimeoutMs > 0
        ? options.delegateTimeoutMs
        : undefined
  }
}

/**
 * Coerces the per-provider concurrency map. Permissive like every other
 * option: non-objects become absent, and entries that are not positive finite
 * numbers are dropped rather than throwing — a misconfigured cap must not
 * take the plugin down.
 */
function parseProviderConcurrency(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const parsed: Record<string, number> = {}
  for (const [provider, limit] of Object.entries(raw)) {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) continue
    const floored = Math.floor(limit)
    if (floored > 0) parsed[provider] = floored
  }
  return Object.keys(parsed).length ? parsed : undefined
}

function pinLocation(root: string, pin: OrchestraOptions['pin']): string | null {
  if (!pin) return null
  return isAbsolute(pin) ? pin : resolvePath(root, pin)
}

/** Absolute path for the debug trace, mirroring how the pin file is resolved. */
function resolveTracePath(root: string, tracePath: string): string {
  return isAbsolute(tracePath) ? tracePath : resolvePath(root, tracePath)
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

/** Extracts the latest assistant turn from the transcript for the output circuit. */
function extractLatestAssistant(messages: readonly unknown[]): { text: string; hadToolCall: boolean } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const msg = messages[index] as { role?: string; content?: unknown }
    if (msg?.role !== 'assistant') continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    let text = ''
    let hadToolCall = false
    for (const part of content) {
      const p = part as { type?: string; text?: string }
      if (p.type === 'text' && typeof p.text === 'string') text += p.text
      else if (p.type === 'tool-use' || p.type === 'tool_call') hadToolCall = true
    }
    return { text: text.trim(), hadToolCall }
  }
  return undefined
}

/** Checks if the transcript contains any user message (for acknowledge). */
function transcriptHasUserMessage(messages: readonly unknown[]): boolean {
  for (const msg of messages) {
    if ((msg as { role?: string })?.role === 'user') return true
  }
  return false
}

/** Detects the free-tier session rejection so the panel can give actionable guidance. */
function isFreeTierError(message: string | undefined): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return lower.includes('free tier') && lower.includes('within opencode')
}

/** Fixed degradation text per host capability, warned once at load. */
const CAPABILITY_WARNINGS: Record<Capability, string> = {
  'model.list': 'the host model catalog is unavailable, so role detection cannot run.',
  'model.default': 'the host model default is unavailable, so the session default is never read or set.',
  'model.transform': 'the host model transform is unavailable, so the session default cannot be set.',
  'agent.transform': 'the host agent transform is unavailable, so no role can be registered.',
  'command.transform':
    'slash commands are unavailable: the host does not provide command.transform, so nothing is registered.',
  'session.create': 'session delegation cannot open turns: the host does not provide session.create.',
  'session.switchAgent': 'session delegation cannot install agents: the host does not provide session.switchAgent.',
  'session.switchModel': 'session delegation cannot set models: the host does not provide session.switchModel.',
  'session.prompt': 'session delegation cannot ask: the host does not provide session.prompt.',
  'session.wait': 'session delegation cannot wait for answers: the host does not provide session.wait.',
  'session.remove': 'delegated sessions cannot be torn down: the host does not provide session.remove.',
  'session.move': 'delegated sessions cannot be moved: the host does not provide session.move.',
  'session.context':
    'context pressure warnings are off: the host does not provide session.context, so no usage is read.',
  'session.hook.retry': 'failure learning is off: the host does not provide the session retry hook.',
  'session.hook.context': 'request decoration is off: the host does not provide the session context hook.',
  'session.hook.compaction':
    'receipt recovery on compaction is off: the host does not provide the session compaction hook.',
  'tool.transform':
    'session delegation tools are unavailable: the host does not provide tool.transform, so none are registered.',
  'tool.hook.execute.before': 'fan-out admission is off: the host does not provide the tool execute.before hook.',
  'tool.hook.execute.after':
    'evidence and fan-out release are off: the host does not provide the tool execute.after hook.',
  'storage.get': 'durable state is process-local: the host does not provide storage.get.',
  'storage.set': 'durable state is process-local: the host does not provide storage.set.',
  'generate.text': 'model probing cannot verify: the host does not provide generate.text, so probes report unverified.'
}

export default {
  id: 'opencode-orchestra',

  async setup(ctx: PluginContextLike) {
    const options = parseOptions(ctx.options)
    if (!options.enabled) return
    const caps = detectCapabilities(ctx)
    for (const name of caps.missing()) {
      // One line per missing capability, once, at load. Fixed text — no ids
      // or timestamps — and never from a loop, or the log fills with repeats.
      if (name !== 'model.list' && name !== 'agent.transform')
        console.warn(`opencode-orchestra: ${CAPABILITY_WARNINGS[name]}`)
    }
    // Required inputs, not optional capabilities: the catalog feeds every
    // assignment and the agent transform *is* the product. Rejecting setup is
    // the correct outcome here, and the error names the capability instead of
    // arriving as a bare TypeError three calls later.
    if (!caps.has('model.list'))
      throw new Error(
        'opencode-orchestra: cannot start: the host does not provide ctx.model.list, which feeds every role assignment.'
      )
    if (!caps.has('agent.transform'))
      throw new Error(
        'opencode-orchestra: cannot start: the host does not provide ctx.agent.transform, which registers every role.'
      )

    const root = ctx.location.directory
    const pinPath = pinLocation(root, options.pin)
    const pinFile = pinPath ? readPin(pinPath) : null

    // The mode's role set, with any explicit `roles` entry winning — so a user who
    // writes both gets what they wrote, and `{ "advisor": null }` brings a role
    // back against a mode that drops it.
    const roleOverrides = modeRoleOverrides(options.mode, options.roles)
    const activeRoles = ROLES.filter(role => roleOverrides[role] !== null)
    const state = {
      resolved: undefined as ResolvedRoles | undefined,
      applied: {} as AppliedMap,
      pinPath,
      pinStatus: pinFile
        ? `read (updated ${pinFile.updated ?? 'unknown'})`
        : pinPath
          ? 'not found, using live detection'
          : 'disabled',
      catalogSize: 0,
      /** Provider ids in the last-seen catalog, for naming unconfigured caps. */
      catalogProviders: [] as string[],
      sessionDefault: undefined as string | undefined,
      quarantine: [] as string[],
      rejected: [] as string[],
      dispatches: [] as DispatchNote[],
      rerouted: 0,
      subagentFallback: 'off' as 'off' | 'armed' | 'unavailable',
      /** Degradation lines for the report, one per lost capability. */
      degraded: [] as string[]
    }
    /** Counters for every dispatch, successes included — `state.dispatches` records only the failures. */
    const telemetry = new DispatchTelemetry()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const disposables: { dispose(): Promise<void> }[] = []
    let registration: { dispose(): Promise<void> } | undefined
    let modelRegistration: { dispose(): Promise<void> } | undefined
    let failures: Record<string, FailureRecord> = {}
    /** Sessions this plugin opened. A refusal in one of these is the plugin's to attribute to a model. */
    const ownedSessions = new Set<string>()
    /**
     * Durable state, or a process-local stand-in. Quarantine and receipts keep
     * working without a host — they just stop surviving a restart, and the
     * report says so.
     */
    const storage = caps.has('storage.get') && caps.has('storage.set') ? ctx.storage : memoryStorage()
    if (storage !== ctx.storage && (options.quarantine !== false || options.receipts !== false)) {
      state.degraded.push(
        'Quarantine and receipts are process-local: the host provides no storage, so learned failures and delegation receipts do not survive a restart.'
      )
    }
    if (options.modeWasUnrecognised) {
      // Loud, because the failure mode is otherwise invisible: the plugin loads,
      // behaves exactly as it did before the option existed, and the user has no
      // reason to look for the cause.
      state.degraded.push(
        `\`mode: ${JSON.stringify(ctx.options.mode)}\` is not one of ${OPERATING_MODES.join(', ')}, so standard is in use.`
      )
    }
    if (options.mode !== 'standard') {
      // Named in the report so the roles missing from the table below are not
      // read as a resolution failure.
      state.degraded.push(
        `Operating mode: ${options.mode}. Reviewers dropped by this mode have no tool registered, so the builder cannot call them.`
      )
    }
    if (!caps.has('generate.text')) {
      state.degraded.push(
        'Model probing cannot verify: the host provides no generate.text, so every probe reports unverified rather than refused.'
      )
    }
    if (options.context !== false && !caps.has('session.context')) {
      state.degraded.push(
        'Context pressure warnings are off: the host provides no session.context, so no usage is read.'
      )
    }
    if (
      options.sessionDelegate !== false &&
      activeRoles.some(role => role !== 'builder') &&
      !caps.has('tool.transform')
    ) {
      state.degraded.push(
        'Session delegation tools are unavailable: the host provides no tool.transform, so no orchestra_* tools are registered.'
      )
    }

    /**
     * Built once, only when `debug` is on. `undefined` means "write nothing", and
     * `delegateToAgent` treats a missing trace as a no-op, so the call sites do
     * not branch on the option.
     */
    const trace = options.debug
      ? createFileTrace(resolveTracePath(root, options.tracePath ?? DEFAULT_TRACE_PATH))
      : undefined

    /**
     * One aggregate line per report, so a run can be priced afterwards without
     * `/orchestra` being opened. Counts and millisecond totals only — never a
     * prompt, a reply or a ref.
     */
    const traceTelemetry = (): void => {
      if (!trace) return
      const snapshot = telemetry.snapshot()
      trace('telemetry', {
        // Process id: these counters are cumulative and process-local, so a
        // reader has to tell one run's repeated reports from another's separate
        // run. Without it the only available grouping is the values themselves,
        // and two runs ending on the same totals would merge into one.
        pid: process.pid,
        dispatches: Object.values(snapshot.roles).reduce((sum, tally) => sum + tally.attempts, 0),
        fellBack: Object.values(snapshot.roles).reduce((sum, tally) => sum + tally.fellBack, 0),
        elapsedTotalMs: Object.values(snapshot.roles).reduce((sum, tally) => sum + tally.elapsedTotalMs, 0),
        gateRefusals: `${snapshot.gates.session}/${snapshot.gates.model}/${snapshot.gates.provider}`,
        // Compactions too. The trace is the only record that outlives the
        // process, and these counters do not — so a figure left out here is a
        // figure that can never be read after the run that produced it, which is
        // the whole length of the window a cut would be argued over.
        compactions: snapshot.compactions,
        receiptsReopened: snapshot.reopened,
        probes: snapshot.probes,
        panels: snapshot.panels
      })
    }

    const evidence = new EvidenceStore()
    const loopGuard = new RepetitionGuard({ refusalTools: REFUSAL_TOOLS })
    const receipts = new ReceiptStore()
    const context = new ContextMonitor({
      warnRatio: options.contextWarnRatio,
      overrideMaxTokens: options.contextMaxTokens
    })
    /** Per-session signals, surfaced by the report and by `/checkpoint`. */
    const sessionState = new Map<string, SessionSignals>()

    /**
     * Writes the pending receipts out.
     *
     * Deliberately not awaited and deliberately un-debounced: storage is not on
     * the critical path of a turn, and a write that is skipped is a receipt that
     * is lost at restart — the exact failure this is here to remove. Receipts
     * are bounded and few, so the volume is nothing like the quarantine store's.
     */
    function persistReceipts(): void {
      if (options.receipts === false) return
      void storage.set(RECEIPT_KEY, receipts.snapshot()).catch(() => undefined)
    }

    async function detect(): Promise<ResolvedRoles> {
      const catalog = (await ctx.model.list()).data ?? []
      state.catalogSize = catalog.length
      state.catalogProviders = [...new Set(catalog.map(model => model.providerID))]
      if (options.context !== false) {
        // The catalog carries each model's real window; use it instead of a
        // fixed assumption, so a 1M model is not judged against 200k.
        context.seed(
          catalog
            .filter(model => model.limit?.context)
            .map(model => ({ ref: `${model.providerID}/${model.id}`, context: model.limit?.context }))
        )
      }
      const resolved = resolveRoles({
        catalog,
        overrides: roleOverrides,
        pins: pinFile?.roles,
        exclude: [...blockedRefs(failures), ...verifiedRefusals.keys()],
        excludeReasons: verifiedRefusalReasons(),
        variants: options.variants
      })
      return resolved
    }

    /**
     * Models a probe found unreachable from this host. Session-scoped, unlike
     * `failures`: a model refused here may work in the TUI, so it must not
     * blacklist anything durably.
     */
    const verifiedRefusals = new Map<string, string>()

    function verifiedRefusalReasons(): Record<string, string> {
      return Object.fromEntries(verifiedRefusals)
    }

    /** Drops refused refs and re-roles, so a probe result takes effect at once. */
    async function applyAfterProbe(): Promise<void> {
      await apply()
    }

    /**
     * Points the session default at the builder's model. A session's model
     * selection takes precedence over an agent's, so without this the builder
     * runs on whatever OpenCode picked as the catalog default.
     */
    async function applyDefaultModel(resolved: ResolvedRoles): Promise<void> {
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
          const spec = roleSpec(role, { hideAdvisor: options.hideAdvisor, steps: options.steps, mode: options.mode })
          const assignment = resolved.assignments[role]
          const model = assignment?.model
          const existing = editor.get(role)
          if (existing) {
            // The project already defines this agent, so keep its prompt and
            // permissions and only retarget the model at what is available now.
            editor.update(role, agent => {
              if (model) agent.model = agentModel(model)
              if (spec.steps) agent.steps = spec.steps
            })
            applied[role] = model ? 'model-only' : 'skipped'
            continue
          }
          editor.update(role, agent => {
            agent.name = spec.name
            agent.description = spec.description
            agent.mode = spec.mode
            agent.hidden = spec.hidden
            agent.color = spec.color
            agent.system = spec.system
            agent.permissions = spec.permissions
            if (model) agent.model = agentModel(model)
            if (spec.steps) agent.steps = spec.steps
          })
          applied[role] = 'created'
        }
        if (options.defaultAgent && editor.get('builder')) editor.default('builder')
      })
      state.applied = applied
      await applyDefaultModel(resolved)
    }

    /**
     * Fan-out admission. The `subagent` permission gates *which* agent runs, not
     * how many at once, so the count is enforced here. Excess launches wait rather
     * than fail: a model refused four searches will usually drop three.
     */
    const fanout = new FanoutAdmission({
      limit: options.maxConcurrentSubagents,
      modelLimit: options.maxConcurrentPerModel,
      providerConcurrency: options.providerConcurrency,
      acquireTimeoutMs: options.fanoutWaitMs,
      // Both routes have to be gated, not just the host's. This plugin's own
      // tools are `orchestra_scout` / `orchestra_advisor` /
      // `orchestra_skeptic`, which reduce to `scout` / `advisor` / `skeptic`
      // — names the default never matched, so an ungated launch was invisible
      // to the gate. `/panel`'s deliberate two-reviewer concurrency runs
      // through here too, which is why the skeptic is listed.
      tool: DELEGATION_TOOLS
    })
    const fanoutLimit =
      options.maxConcurrentSubagents === 0 ? 0 : (options.maxConcurrentSubagents ?? FANOUT_DEFAULTS.limit)

    // Everything below can throw against a deficient host (a rejected hook, a
    // transform the host does not honor). The catch at the end unwinds what
    // was registered so a mid-setup throw leaks nothing, then rethrows: a
    // half-loaded plugin that reports healthy is worse than a failed one.
    try {
      await apply()

      /**
       * Rehydrate receipts left by a previous run of the plugin.
       *
       * Only the unconsumed ones are ever written, so this restores exactly the
       * answers that were in flight when the process went away — a delegation is
       * the one thing here that can still be *resumed* rather than merely reported.
       * A snapshot that fails its shape check is dropped whole: a half-restored
       * receipt would be re-injected as fact, which is worse than losing it.
       */
      if (options.receipts !== false) {
        const stored = (await storage.get(RECEIPT_KEY)) as ReceiptSnapshot | undefined
        receipts.restore(stored)
      }

      /**
       * Learns from provider failures. The catalog can list a model as active while
       * the provider has withdrawn it, so a role that keeps failing leaves detection
       * and the team is re-roled at once. Rate limits are counted first — one busy
       * minute should not cost us a model.
       *
       * A model the provider only refuses *here* (the free-tier / host-restriction
       * wording) is recorded and reported, never blocked: it works in the TUI, and
       * quarantine is global and lasts two weeks. Blocking would trade a real model
       * for a message no retry can fix, so the report says what happened and the pin
       * stays the human's call.
       */
      if (options.quarantine !== false) {
        const stored = (await storage.get(QUARANTINE_KEY)) as Record<string, FailureRecord> | undefined
        failures = pruneRecords(stored ?? {}, Date.now() - QUARANTINE_TTL)
        if (Object.keys(failures).length) {
          state.quarantine = describeQuarantine(failures)
          state.rejected = describeRejections(failures)
          await apply()
        }

        const retryRegistration = await ctx.session.hook('retry', event => {
          // A credential refusal charged to a model suppresses dispatch for a model that answers
          // fine over an ordinary session, so only sessions this plugin opened may attribute one.
          if (isCredentialRefusal(event.error) && !ownedSessions.has(event.sessionID)) return
          const ref = `${event.model.providerID}/${event.model.id}`
          const result = recordFailure(failures, ref, event.error, Date.now())
          if (result.kind === 'ignore') return
          failures = result.records
          void storage.set(QUARANTINE_KEY, failures).catch(() => undefined)
          // Both summaries are derived from the whole store and cost nothing, so
          // they refresh on every recorded failure. `changed` only fires when a
          // model is newly blocked, and waiting for it would leave a rejection
          // invisible in the report — which is the only place it is ever surfaced.
          state.quarantine = describeQuarantine(failures)
          state.rejected = describeRejections(failures)
          if (!result.changed) return
          // The model that just failed may be holding a role; re-pick without it.
          void apply().catch(() => undefined)
        })
        disposables.push(retryRegistration)
      }

      /**
       * Evidence. A model's "done" is a claim; this records which files it wrote
       * and whether a verification command has run since. Nothing is enforced —
       * the signal is surfaced in the report and injected into the builder's
       * system prompt on each request, because a plugin cannot decide whether
       * code is correct but can make sure the model is asked.
       */
      if (options.evidence !== false) {
        disposables.push(
          await ctx.tool.hook('execute.after', event => {
            const tool = effectiveToolId(event.tool)
            evidence.record(event.sessionID, tool, event.input, event.status)
            const signals = sessionState.get(event.sessionID) ?? {}
            signals.evidence = evidence.describe(event.sessionID)
            sessionState.set(event.sessionID, signals)
          })
        )
      }

      /**
       * Loop guard recording. Registered **outside** the `evidence` block: with
       * it inside, the only way to switch the guard off was an unrelated knob
       * (`evidence: false`), which is the coupling this separation removes.
       *
       * The plugin's own delegation tools are exempt — the builder prompt tells
       * the model to call `orchestra_scout` repeatedly, so three delegations
       * would otherwise trip a circuit describing the plugin working.
       */
      if (options.loopGuard !== false) {
        disposables.push(
          await ctx.tool.hook('execute.after', event => {
            const tool = effectiveToolId(event.tool)
            if (DELEGATION_TOOLS.includes(tool as (typeof DELEGATION_TOOLS)[number])) return
            loopGuard.recordTool({
              sessionID: event.sessionID,
              tool,
              input: event.input,
              status: event.status,
              result: resultDigest(event)
            })
          })
        )
        // The refusal, one threshold above the reporting one. Throws through
        // the hook the same way the fan-out gate does, which is the one refusal
        // primitive verified against the live host. Derived from the confirmed
        // repeat count, so it survives the 30s auto-clear that would expire an
        // `open`-derived refusal exactly when it is still needed.
        disposables.push(
          await ctx.tool.hook('execute.before', event => {
            // `execute.before` carries no status and no result ([host-H13]), so
            // the pending launch is judged on its identity alone.
            if (loopGuard.decide({ sessionID: event.sessionID, tool: event.tool, input: event.input })) {
              const verdict = loopGuard.peek(event.sessionID)
              throw new Error(
                `orchestra: refusing "${event.tool}" — ${verdict.confirmedRepeats} identical calls with identical results in a row. Something this read cannot answer has already been read. Try a different search, or ask the user.`
              )
            }
          })
        )
      }

      if (fanoutLimit > 0) {
        disposables.push(
          await ctx.tool.hook('execute.before', async event => {
            // Per-model admission needs the model the launch will actually use,
            // which the raw hook event does not carry. Resolved here, at the one
            // place that knows the assignment, rather than guessed in the gate.
            const agent = (event.input as { agent?: string } | undefined)?.agent
            const model = agent ? state.resolved?.assignments[agent as RoleName]?.model : undefined
            try {
              await fanout.admit({
                ...event,
                ...(model ? { model: `${model.providerID}/${model.id}` } : {})
              })
            } catch (error) {
              // Counted here, then rethrown unchanged: this is the only place a
              // refusal passes through, and the dimension rides on the error
              // rather than being recovered from the message.
              const dimension = (error as Partial<{ fanoutDimension: GateDimension }>).fanoutDimension
              if (dimension) telemetry.recordGateRefusal(dimension)
              throw error
            }
          })
        )
        // Registered separately from the evidence hook so that turning evidence off
        // cannot leave subagent slots held forever.
        disposables.push(
          await ctx.tool.hook('execute.after', event => {
            fanout.release(event)
          })
        )
      }

      /**
       * Context pressure. Uses each model's real window from the catalog, so a
       * 1M-token model is judged against 1M rather than a hardcoded default.
       *
       * Sessions with a usage read in flight, so one turn makes at most one call.
       */
      const pendingUsage = new Set<string>()

      if (options.context !== false) {
        disposables.push(
          await ctx.session.hook('context', event => {
            // This hook carries no `kind` field, verified against the running host:
            // filtering on `kind === "primary"` discarded every event. A session has
            // one primary loop, so treat any event as the main one.
            context.rememberModel(event.sessionID, event.model.providerID, event.model.id)

            // Evidence, told to the builder directly. A model's "done" is a claim,
            // and this is the only channel that reaches it before it decides it is
            // finished — which is why the signal lives here and not only in a report
            // the user has to ask for.
            //
            // Appended, not inserted, so the agent's own prompt keeps the lead, and
            // skipped once every changed file has been verified: repeating a settled
            // warning is noise that trains the model to ignore the line that
            // mattered.
            if (options.evidence !== false && Array.isArray(event.system)) {
              const entry = sessionState.get(event.sessionID)?.evidence
              if (entry) event.system.push({ type: 'text', text: `Verification: ${entry}` })
            }
            // Receipts. The builder is the only thing that can act on "you delegated
            // this and nobody knows what came back". A compaction drops the answer
            // silently, and silence reads exactly like a scout that found nothing.
            //
            // The consumption check runs first, on the outgoing transcript, so a
            // receipt stops being offered the moment the answer is in front of the
            // builder. Re-injecting one it already has is how this block grows into
            // noise the model learns to skip.
            if (options.receipts !== false && Array.isArray(event.system)) {
              if (receipts.noteTranscript(event.sessionID, event.messages)) persistReceipts()
              const block = receipts.injection(event.sessionID)
              if (block) event.system.push({ type: 'text', text: block })
            }

            // Loop guard output circuit + acknowledge.
            // The context hook fires on every model request with the outgoing transcript.
            // - recordOutput: the latest assistant turn becomes the "output" signal. A
            //   tool-using turn (hadToolCall=true) resets the output signal, per the
            //   guard's design — real work is not repetition.
            // - acknowledge: any user message in the transcript clears an open circuit.
            //   This includes `/orchestra`, `/checkpoint`, `/panel` which send via
            //   ctx.session.prompt and land as user messages. Accepted rather than
            //   filtered (like RECEIPT_MARKER) because a plugin command IS a user turn.
            if (options.loopGuard !== false) {
              const latestAssistant = extractLatestAssistant(event.messages)
              if (latestAssistant) {
                loopGuard.recordOutput({
                  sessionID: event.sessionID,
                  text: latestAssistant.text,
                  hadToolCall: latestAssistant.hadToolCall
                })
              }
              if (transcriptHasUserMessage(event.messages)) {
                loopGuard.acknowledge(event.sessionID)
              }
            }

            // The hook's `messages` are the outgoing transcript and carry no token
            // counts, so usage comes from the session record — an extra read per
            // turn. Deferred rather than inline: a hook must not add latency to the
            // request it decorates. The guard keeps it to one call per session.
            //
            // Skipped wholesale without the capability: the monitor reports
            // nothing rather than a default limit as if it were real.
            if (!caps.has('session.context')) return
            if (pendingUsage.has(event.sessionID)) return
            pendingUsage.add(event.sessionID)
            void ctx.session
              .context({ sessionID: event.sessionID })
              .then(messages => {
                const usage = usageFromMessages(messages)
                if (!usage) return
                const reading = context.observe(event.sessionID, usage)
                const signals = sessionState.get(event.sessionID) ?? {}
                signals.context = reading.warning ? reading.note : undefined
                sessionState.set(event.sessionID, signals)
              })
              .catch(() => undefined)
              .finally(() => pendingUsage.delete(event.sessionID))
          })
        )
      }

      /**
       * Compaction re-opens every consumed receipt: it is the one moment a
       * consumed answer can be lost again. Registered on the real `compaction`
       * hook (H3) — the old `event.kind === 'compaction'` check inside the
       * context handler was unreachable because context events carry no `kind`
       * (H2). The event is a full session context; only the session id is read.
       */
      if (options.receipts !== false) {
        disposables.push(
          await ctx.session.hook('compaction', event => {
            const reopened = receipts.reopen(event.sessionID)
            if (reopened) persistReceipts()
            // Counted even at zero: that is the measurement a cut of receipt
            // persistence would have to argue against.
            telemetry.recordCompaction(reopened)
          })
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
        if (options.receipts !== false && receipts.prune()) persistReceipts()
        // Fan-out bookkeeping only: dropping slots wholesale would free live ones
        // and let a slow child push the session over its own limit.
        fanout.prune()
        // `telemetry` is deliberately NOT pruned. Every other store here drops
        // state that has gone quiet; this one measures whether a mechanism is
        // used often enough to keep, and an aggregate that expires cannot
        // answer that. It lives as long as the process.
      }, 5 * 60_000)
      timers.add(pruneTimer as unknown as ReturnType<typeof setTimeout>)

      if (!options.commands) {
        return () => {
          for (const timer of timers) clearTimeout(timer)
          fanout.reset('the plugin unloaded')
          for (const item of disposables) void item.dispose()
          void registration?.dispose()
        }
      }

      const send = async (input: CommandInvocationLike, text: string) => {
        await ctx.session.prompt({
          ...input.prompt,
          sessionID: input.sessionID,
          text,
          delivery: input.delivery ?? 'steer'
        })
      }

      const pinLabel = (path: string | null) =>
        path && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

      const report = async (verbose = false, input?: CommandInvocationLike) => {
        const sessionDefault = await ctx.model
          .default()
          .then(result => {
            const model = result?.data
            return model ? `${model.providerID}/${model.id}` : undefined
          })
          .catch(() => undefined)
        // Reported regardless of `verbose`: a trace run that cannot be priced
        // afterwards answers nothing about what the run cost.
        traceTelemetry()
        return renderReport({
          resolved: state.resolved!,
          applied: state.applied,
          pinPath: pinLabel(state.pinPath) ?? DEFAULT_PIN_PATH,
          pinStatus: state.pinStatus,
          version: PLUGIN_VERSION,
          verbose,
          sessionDefault,
          defaultModelEnabled: options.defaultModel,
          quarantine: state.quarantine,
          rejected: state.rejected,
          warnings: catalogWarnings(sessionDefault),
          signals: input ? signalsFor(input.sessionID) : undefined,
          // Claims ride their own report input rather than going through
          // `signalsFor`: that channel feeds `/checkpoint` too, where a claim list
          // would read as runtime advice rather than as what the roles asserted.
          claims: input ? evidence.describeClaims(input.sessionID) : undefined,
          // Opt-in, and omitted entirely when nothing has happened yet, so the
          // verbose report does not carry an empty measurement section.
          diagnostics:
            verbose && !telemetry.isEmpty()
              ? describeTelemetry(telemetry.snapshot(), input ? evidence.summarize(input.sessionID) : undefined)
              : undefined
        })
      }

      /**
       * The single family every candidate for a role belongs to, or undefined.
       * One candidate is deliberately not a claim — a single-model project has no
       * choice to make. The contention warning covers that shape.
       */
      function familyOfRole(resolved: ResolvedRoles, role: RoleName): string | undefined {
        if (resolved.candidates.length < 2) return undefined
        const families = new Set(resolved.candidates.map(candidate => candidate.family).filter(Boolean))
        if (families.size !== 1) return undefined
        return [...families][0]
      }

      function catalogWarnings(sessionDefault?: string): string[] | undefined {
        const resolved = state.resolved
        const warnings: string[] = []
        // Dispatch history rides the same channel. `renderReport` owns the wording
        // of every section, and a new section is a bigger claim than this needs:
        // what matters is that a role which moved is not silently indistinguishable
        // from one that did not, and every warning line is already a fact about
        // how the assignments below should be read.
        //
        // Collected before the catalog guards below because a dispatch can fail
        // with no catalog at all — the session model, no chain — and that failure is
        // exactly the one a user is looking for.
        for (const note of state.dispatches) warnings.push(describeDispatch(note))
        // Degraded capabilities ride the same channel, for the same reason: a
        // role that silently lost its tool or its probe is indistinguishable
        // from one that never had them.
        for (const notice of state.degraded) warnings.push(notice)
        // Whether the reroute is even possible is the difference between "delegation is broken"
        // and "this host does not expose a tool to rewrite", so it is never a silent no-op.
        if (state.subagentFallback === 'unavailable') {
          warnings.push(
            'This host does not expose its `subagent` tool to plugins, so a launch it refuses cannot be rerouted. Use `orchestra_scout` / `orchestra_advisor` instead.'
          )
        } else if (state.rerouted > 0) {
          warnings.push(
            `${state.rerouted} host \`subagent\` launch(es) were refused as a credential restriction and rerouted over an ordinary session. Native child sessions are not permitted here.`
          )
        }
        if (!resolved?.candidates.length) return warnings.length ? warnings : undefined
        const providers = new Set(resolved.candidates.map(c => c.providerID))

        if (providers.size === 1) {
          warnings.push(
            `Every candidate comes from one provider (\`${[...providers][0]}\`). Model selection here can only choose within it, so a provider-side restriction takes out every role at once.`
          )
        }

        // A role whose entire candidate set is one family has no choice, whatever
        // its score says. Grouping is on the catalog's own `family` field, not on
        // name keywords: two unrelated models can share a keyword by coincidence,
        // and a warning built on a coincidence is worse than no warning.
        for (const role of ROLES) {
          const family = familyOfRole(resolved, role)
          if (!family) continue
          const label = roleSpec(role).name
          warnings.push(
            `Every candidate for ${label} is in the \`${family}\` family, so its assignment is the only one the scorer could have reached. A family-wide problem takes out this role regardless of the model chosen.`
          )
        }

        // Two roles contending for one backend. The per-model gate can now shed
        // that load, but only if it is visible — otherwise it looks like the roles
        // were chosen independently.
        const byRef = new Map<string, RoleName[]>()
        for (const role of ROLES) {
          const model = resolved.assignments[role]?.model
          if (!model) continue
          const ref = `${model.providerID}/${model.id}`
          byRef.set(ref, [...(byRef.get(ref) ?? []), role])
        }
        for (const [ref, roles] of byRef) {
          if (roles.length > 1) {
            warnings.push(
              `${roles.map(role => roleSpec(role).name).join(' and ')} share \`${ref}\`. They contend for one backend; \`maxConcurrentPerModel\` caps that, and neither role is cheaper than it would be alone.`
            )
          }
        }
        // A configured provider no catalog model comes from binds nothing: the
        // cap exists, but nothing can ever count against it. Named rather than
        // ignored, the way an unwrappable `subagent` tool is.
        for (const name of Object.keys(options.providerConcurrency ?? {})) {
          if (!state.catalogProviders.includes(name)) {
            warnings.push(
              `\`providerConcurrency\` names \`${name}\`, which no catalog model uses, so that cap binds nothing. Remove it or check the provider id.`
            )
          }
        }
        if (verifiedRefusals.size) {
          warnings.push(
            `${verifiedRefusals.size} model(s) were refused from this host and are excluded for this session only: ${[...verifiedRefusals.keys()].join(', ')}.`
          )
        }
        const builder = resolved.assignments.builder?.model
        if (sessionDefault && builder && `${builder.providerID}/${builder.id}` !== sessionDefault) {
          warnings.push(
            `The session runs on \`${sessionDefault}\`, not the builder's \`${builder.providerID}/${builder.id}\`. A session's model wins, so set \`defaultModel\` or the assignment below is decorative.`
          )
        }
        return warnings.length ? warnings : undefined
      }

      /** One dispatch, in the report's voice: what moved, and what stopped it. */
      function describeDispatch(note: DispatchNote): string {
        const label = roleSpec(note.role).name
        const first = note.tried[0] ?? 'the session model'
        if (!note.retried) {
          return `The ${label} failed at dispatch on \`${first}\` and was not retried: ${note.why}.`
        }
        const second = note.tried[1] ?? 'the next candidate'
        return (
          `The ${label} failed at dispatch on \`${first}\` and was retried once on \`${second}\`, ` +
          `which ${note.why === 'answered' ? 'answered' : 'also failed'}. ` +
          'The assignment below is still the detected pick, so pin the working model if this repeats.'
        )
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

      /**
       * Probes each assigned model and returns the user-facing lines. Shared by
       * `/orchestra-probe` and `/orchestra probe` so the two cannot drift.
       */
      async function runProbe(): Promise<string[]> {
        const resolved = state.resolved
        if (!resolved) return ['No assignment is available yet.']
        const assignments = Object.fromEntries(ROLES.map(role => [role, resolved.assignments[role]?.model])) as Partial<
          Record<RoleName, ModelRef | undefined>
        >

        // Counted before the run: a probe that throws still cost a request, and
        // the counter exists to price the thing.
        telemetry.recordProbe(ROLES.filter(role => resolved.assignments[role]?.model).length)

        const results = await probeAssignments({
          assignments,
          generate: caps.has('generate.text') ? ctx.generate : undefined,
          // `generate` runs without a session, which the free tier refuses. A real
          // session is the closest a plugin gets to an in-app request, so it is
          // the second attempt rather than a replacement.
          //
          // The directory itself is *not* baked into the adapter:
          // `probeAssignments` is told where to run and puts it on `create`, so
          // the session is born in the project rather than moved into it after.
          session: sessionAdapter(ctx, caps),
          directory: root,
          options: { timeoutMs: options.probeTimeoutMs }
        })
        // Record what each role's model actually did, so the report can tell
        // "answered" apart from "the catalog claims it exists". Without this the
        // table reads "detected" either way, which is precisely how a refused
        // model stayed invisible.
        for (const result of results) {
          const assignment = state.resolved?.assignments[result.role]
          if (!assignment) continue
          assignment.verification =
            result.verdict === 'ok' ? 'verified' : result.verdict === 'refused' ? 'refused' : 'unknown'
        }
        const dead = deadRoles(results)
        const lines = [results.map(describeProbe).join('\n'), '']

        // Feed the verdicts back into detection. Only refusals count: an
        // `unverified` result means the probe never reached the provider, so
        // excluding on it would discard a healthy model because the network was
        // down.
        const before = verifiedRefusals.size
        for (const result of results) {
          if (result.verdict !== 'refused' || !result.model) continue
          verifiedRefusals.set(`${result.model.providerID}/${result.model.id}`, result.detail)
        }
        const learned = verifiedRefusals.size - before

        if (!dead.length) {
          lines.push('Every assigned model answered.')
          return lines
        }
        lines.push(
          `Refused: ${dead.join(', ')}. Detection cannot see this — the catalog still reports these models as active.`
        )
        if (learned > 0) {
          lines.push(
            `Re-detected without ${learned} refused model(s), so the roles below have moved. This is remembered for this session only: a model refused here may still work in the TUI.`
          )
          await applyAfterProbe()
        }
        lines.push('If a role is still refused, pin a model that answers:')
        for (const role of dead) {
          const pin = suggestPin(results, role)
          if (pin) lines.push(`  ${pin}`)
        }
        return lines
      }

      async function editorRunProbe(input: CommandInvocationLike) {
        const lines = await runProbe()
        await send(
          input,
          [
            'Report the probe results below to the user.',
            'Keep it to a few lines: one per role, then whether anything needs repinning.',
            'If a role was refused, say plainly that detection cannot predict this and that the pin is the fix.',
            'If a role was merely unverified (timeout or unreachable), say so rather than calling it broken.',
            '',
            lines.join('\n')
          ].join('\n')
        )
      }

      /**
       * The models a dispatch for `role` may try, best first.
       *
       * `fallbackChain` skips anything quarantine blocked or the provider refused,
       * so a role whose own assignment is excluded leaves the chain empty — and an
       * empty chain used to dispatch with **no model at all**. The session inherited
       * whatever the server defaults to, which is not the role's model, and the turn
       * failed far from anything the report names.
       *
       * So an empty chain falls back to the assignment, skipping nothing. A pin or
       * override is deliberate, and quietly substituting another model for it is
       * worse than using the one asked for and reporting that it failed. Rejected
       * is not skipped for the same reason `rejectedRefs` exists: a rejection says
       * it fails *outside* the host, which may still be true in the TUI.
       */
      function dispatchTargets(role: RoleName): (RankedCandidate | undefined)[] {
        const resolved = state.resolved
        if (!resolved) return [undefined]
        const skipRefs = [
          ...blockedRefs(failures),
          // Rejected models join the skip list here and only here. Detection
          // deliberately still sees them — a rejection says the model works in the
          // TUI — so nothing upstream removes them from the ranked order.
          // Skipping them for dispatch is what stops the fallback walking
          // straight back into the refusal it was called to escape.
          ...rejectedRefs(failures),
          ...verifiedRefusals.keys()
        ]
        const chain = fallbackChain(resolved, role, skipRefs)
        if (chain.length) return chain

        // Chain is empty: all candidates were skipped (refused/blocked).
        // Do NOT return the assigned model if it is also refused AND it was
        // detected (not pinned). A pin/override is a deliberate user choice that
        // should be honored even if the model is quarantined — the quarantine
        // exists for detected models, not for explicit configuration.
        const assigned = resolved.assignments[role]?.model
        const assignedSource = resolved.assignments[role]?.source
        if (assigned) {
          const assignedRef = `${assigned.providerID}/${assigned.id}`
          const isPinned = assignedSource === 'pin' || assignedSource === 'override'
          if (skipRefs.includes(assignedRef) && !isPinned) return [undefined]
          return [{ ref: assignedRef, score: 0, model: assigned }]
        }
        return [undefined]
      }

      /**
       * Whether the chain advances past a failure, and why.
       *
       * Its own function rather than three conditions inline: each branch is a
       * decision to spend or refuse a provider call, and they read as one another.
       * The order matters — each check answers a question a reader asks first. Was
       * this role ever a fallback candidate? Does the failure look like the model's
       * fault? Have we already retried? Is there anywhere left to go?
       */
      function stopDispatch(
        role: RoleName,
        error: string | undefined,
        index: number,
        remaining: number
      ): { advance: boolean; why: string } {
        // The advisor is called rarely, deliberately, and its answer is acted on.
        // Substituting a different model behind the user's back would hide a bad
        // pin — the one thing a pin is for — behind a working answer.
        // BUT: only protect EXPLICIT pins/overrides, not detected models. A detected
        // advisor that is refused should fall back like any other role.
        const resolvedForDispatch = state.resolved
        if (role === 'advisor') {
          const source = resolvedForDispatch?.assignments?.advisor?.source
          if (source === 'pin' || source === 'override') {
            return {
              advance: false,
              why: 'the advisor is explicitly pinned, and a fallback would hide a bad pin rather than fix one'
            }
          }
          // Detected advisor: fall through to transport-fault check below
        }
        // Fault attribution. A refusal will refuse again on the next candidate; a
        // broken task is broken on every model, so retrying it spends a provider
        // call and doubles the fan-out cost to arrive at the same error twice.
        if (!looksLikeTransportFault(error))
          return {
            advance: false,
            why: 'the failure reads as the task rather than the model, so another model would re-run the same broken work'
          }
        // Exactly once. A second failure is an answer about the work, not about
        // this model, and a loop here would burn the budget on every dispatch.
        if (index > 0) return { advance: false, why: 'the retry already fired once, so this is the answer' }
        if (remaining < 1) return { advance: false, why: 'no other candidate is left to try' }
        return { advance: true, why: '' }
      }

      /**
       * Runs one role's turn, walking the fallback chain at most once, and leaves a
       * receipt behind. `sessionID` is the builder's own, from the tool context:
       * a delegation opens its own session, so that is the only handle tying the
       * receipt to the turn that asked. Only `delegateToAgent` failures retry —
       * the native `subagent` launch is not a dispatch this plugin owns.
       */
      async function dispatchRole(role: RoleName, text: string, sessionID?: string): Promise<DelegationResult> {
        const chain = dispatchTargets(role)
        const tried: string[] = []
        let result: DelegationResult | undefined
        let why = 'answered'

        // Opened before the first provider call rather than after it returns: a
        // turn killed mid-flight produces no result, and that is exactly the case
        // a receipt has to be able to report.
        const receipt = sessionID ? receipts.begin(sessionID, role, text) : undefined
        if (receipt) persistReceipts()

        for (const [index, candidate] of chain.entries()) {
          tried.push(candidate?.ref ?? 'the session model')
          result = await delegateToAgent(sessionAdapter(ctx, caps), {
            agent: role,
            directory: root,
            text,
            // The whole ref, variant included: `RankedCandidate.model` carries the
            // reasoning effort the resolver picked for this role, and dropping it
            // runs the delegated turn on a different budget than the assignment
            // the report names.
            ...(candidate ? { model: candidate.model } : {}),
            timeoutMs: options.delegateTimeoutMs,
            onSession: id => ownedSessions.add(id),
            ...(trace ? { trace } : {})
          })
          if (result.ok) {
            why = 'answered'
            break
          }
          const stop = stopDispatch(role, result.error, index, chain.length - index - 1)
          why = stop.why
          if (!stop.advance) break
        }

        /**
         * Counted on every dispatch, not just the awkward ones. A tally that
         * skipped the successes could not answer "how often does this role fall
         * back", which is what a gate's existence turns on.
         */
        const stopped = result!
        telemetry.recordDispatch(role, {
          ok: stopped.ok,
          elapsedMs: stopped.elapsedMs,
          candidates: tried.length
        })

        // The failure log is unchanged: this records what went wrong, and a
        // first-candidate success has nothing to say.
        if (!stopped.ok || tried.length > 1) {
          state.dispatches = [...state.dispatches, { role, tried, retried: tried.length > 1, why }].slice(
            -DISPATCH_HISTORY
          )
        }
        // Settled here rather than at the return of each candidate, so the
        // receipt describes the dispatch as a whole: a role that refused and then
        // answered is `delivered`, and one that refused twice is `failed` once.
        if (sessionID && receipt) {
          receipts.settle(sessionID, receipt.id, stopped, tried)
          persistReceipts()
        }

        // Claims. The role answered, so what it said is filed as a reference —
        // never a copy, and never a gate. A claim that nothing backs shows up in
        // the report as a gap; it never blocks this return.
        //
        // Best-effort by design: the envelope is a prompt contract with a soft
        // edge, so a reply that does not match it yields no claims rather than an
        // error. A scout that answered well in free-form prose has still helped.
        if (sessionID && stopped.ok && stopped.text) {
          // Through `claimsFromEnvelope` so reference
          // filtering and bounding live in one place rather than being re-derived
          // here with a second regex that would drift from it.
          const lines = stopped.text
            .split(/\n+/)
            .map(line => line.replace(/^[-*\d.\s]+/, '').trim())
            .filter(line => line.length > 12)
            .slice(0, HANDOFF_LIMITS.maxFindings)
          // The envelope types are strict on purpose, so this satisfies them
          // rather than casting: `FileRef` is `\`\${string}:\${number}\``, and the
          // confidence union is the producer's own settledness, not a support
          // verdict — support is resolved later, at read time.
          const refs = [...stopped.text.matchAll(/([^\s`,)]+:\d+)/g)]
            .map(match => match[1]!)
            .filter((ref): ref is FileRef => /^[^\s`,)]+:\d+$/.test(ref))
          for (const claim of claimsFromEnvelope(role, {
            findings: lines,
            filesTouched: refs,
            confidence: 'medium',
            openQuestions: []
          })) {
            evidence.recordClaim(sessionID, claim)
          }
        }
        return stopped
      }

      /**
       * Registers the session-backed delegation tool.
       *
       * The host's `subagent` launch creates a child session, which a free-tier
       * credential refuses outright. An ordinary session is accepted, so this runs
       * the same agent the same way through a route that works. Registered
       * *alongside* the built-in tool rather than instead of it: on credentials
       * that allow child sessions the native path is still the better one, and
       * nothing here should take that choice away.
       */
      if (
        options.sessionDelegate !== false &&
        activeRoles.some(role => role !== 'builder') &&
        caps.has('tool.transform')
      ) {
        disposables.push(
          await ctx.tool.transform(editor => {
            // NOTE: no editor.namespace() call and no options on the adds below.
            // Both were bisected live on 2.0.27 [host-H1]: a tool whose name
            // collides with a host tool id (`scout`, `advisor`, `skeptic`) is
            // silently dropped, and so is any tool carrying `options` or a
            // declared `output`. Unique bare names with a plain input object are
            // what registers — in sessions and the codemode catalog alike.
            for (const role of activeRoles) {
              if (role === 'builder') continue
              const spec = roleSpec(role, { hideAdvisor: options.hideAdvisor })
              editor.add({
                name: `orchestra_${role}`,
                description: `${spec.description} Runs over a session, so it works where a child session is refused.`,
                input: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: `The question or instruction for the ${spec.name}.` }
                  },
                  required: ['text'],
                  additionalProperties: false
                },
                execute: async (raw: unknown, context?: { progress?: (update: unknown) => Promise<void> }) => {
                  const text = (raw as { text?: string })?.text
                  if (!text) return { content: [{ type: 'text', text: 'A question is required.' }] }
                  // The builder's session id, read off the tool context the host
                  // passes in. Needed so the receipt can be re-injected into the
                  // session that asked rather than into all of them; without it
                  // the dispatch still runs and simply leaves no receipt.
                  const sessionID = (context as { sessionID?: string } | undefined)?.sessionID
                  const result = await dispatchRole(role, text, sessionID)
                  if (!result.ok) {
                    return {
                      content: [{ type: 'text', text: `The ${spec.name} did not answer: ${result.error}` }],
                      isError: true
                    }
                  }
                  return { content: [{ type: 'text', text: result.text! }] }
                }
              })
            }

            /**
             * The builder's most natural call is `subagent`, and that is the one the host refuses
             * here: it opens a child session, which a free tier rejects while the same model answers
             * an ordinary session. Left alone, the prompt's own instruction fails every time.
             *
             * Wrapped rather than replaced — the native launch runs first and only a credential
             * refusal reroutes, so a credential that permits child sessions keeps using them.
             */
            if (options.subagentFallback !== false) {
              let wrapped = false
              try {
                editor.update('subagent', tool => {
                  const native = tool.execute
                  if (typeof native !== 'function') return
                  tool.execute = async (raw: unknown, toolContext?: { sessionID?: string }) => {
                    try {
                      return await (native as (...args: unknown[]) => Promise<unknown>)(raw, toolContext)
                    } catch (error) {
                      const detail = error instanceof Error ? error.message : String(error)
                      if (!isCredentialRefusal(detail)) throw error
                      const input = raw as { agent?: string; prompt?: string }
                      const role = activeRoles.find(candidate => candidate === input.agent)
                      if (!role || role === 'builder' || !input.prompt) throw error
                      state.rerouted += 1
                      const result = await dispatchRole(role, input.prompt, toolContext?.sessionID)
                      return result.ok
                        ? { content: [{ type: 'text', text: result.text! }] }
                        : {
                            content: [{ type: 'text', text: `The ${role} did not answer: ${result.error}` }],
                            isError: true
                          }
                    }
                  }
                  wrapped = true
                })
              } catch {
                wrapped = false
              }
              // Read from whether the updater ran, not from whether `update` threw: a host that does
              // not have the id ignores the call silently, and a reroute believed to be armed but is
              // not is the one failure this whole path exists to stop.
              state.subagentFallback = wrapped ? 'armed' : 'unavailable'
            }
          })
        )
      }

      // No commands without the capability. Unreportable in-product — the report
      // *is* a command — so the load-time warning is the only channel.
      if (caps.has('command.transform')) {
        await ctx.command.transform(editor => {
          editor.add({
            name: 'orchestra-probe',
            description: 'Send a real request to each assigned model and report which ones answer.',
            execute: input => editorRunProbe(input)
          })

          editor.add({
            name: 'orchestra',
            description: 'Show which models the orchestra picked for builder, scout and advisor, and why.',
            execute: async input => {
              const argument = input.prompt?.text ?? ''
              // "version" is answered here rather than in the report so the answer
              // is one line, not a full assignment table. Diagnostics only.
              if (/\bversion\b/i.test(argument)) {
                await send(input, `opencode-orchestra ${PLUGIN_VERSION}. Report this version in one line and stop.`)
                return
              }
              // "probe" is handled here rather than as a separate command so that
              // `/orchestra probe` reads the way a user would expect it to.
              if (/\bprobe\b/i.test(argument)) {
                await editorRunProbe(input)
                return
              }
              if (/\b(recheck|refresh|redo)\b/i.test(argument)) {
                await apply()
                state.pinStatus = pinFile
                  ? `read (updated ${pinFile.updated ?? 'unknown'}); re-detected ${state.catalogSize} models`
                  : `not found, using live detection (${state.catalogSize} models)`
              }
              await send(
                input,
                [
                  'Report the orchestra assignment below to the user.',
                  'Keep it short: the table is the answer. Then note only roles that look wrong for this project and, if so, the exact pin line that would fix them.',
                  '',
                  await report(/\b(all|verbose|debug)\b/i.test(argument), input)
                ].join('\n')
              )
            }
          })

          editor.add({
            name: 'orchestra-pin',
            description: 'Freeze the current model assignment into the orchestra pin file.',
            execute: async input => {
              await apply()
              if (!state.pinPath) {
                await send(input, "Pinning is disabled in this project's plugin options.")
                return
              }
              if (!state.resolved?.candidates.length) {
                await send(input, 'No tool-capable model is available here, so there is nothing to pin yet.')
                return
              }
              const pin = buildPin(state.resolved, state.catalogSize, activeRoles)
              writePin(state.pinPath, pin)
              state.pinStatus = `written (${pin.updated})`
              const specs = activeRoles.map(role =>
                roleSpec(role, { hideAdvisor: options.hideAdvisor, steps: options.steps })
              )
              const models = Object.fromEntries(
                activeRoles.map(role => [role, state.resolved!.assignments[role]!.model])
              ) as Record<RoleName, ModelRef | undefined>
              await send(
                input,
                [
                  `Wrote the pin file \`${pinLabel(state.pinPath!)}\`.`,
                  '',
                  await report(false, input),
                  '',
                  'To move a role off live detection permanently, add an `agents` block to `opencode.jsonc`:',
                  '',
                  '```jsonc',
                  toJsonc({ agents: staticAgentBlock(specs, models) }),
                  '```'
                ].join('\n')
              )
            }
          })

          editor.add({
            name: 'checkpoint',
            description: 'Ask the advisor (strong reasoning model) for a verdict before continuing.',
            execute: async input => {
              const signals = signalsFor(input.sessionID)
              await send(
                input,
                [
                  'Run an advisor checkpoint before going further.',
                  '',
                  '1. Launch `orchestra_advisor`. Give it what it needs to judge: the current plan or diff, the failing command output if something is failing, and one explicit question.',
                  ...(signals?.length
                    ? ['', 'Runtime signals to include:', ...signals.map(entry => `- ${entry}`)]
                    : []),
                  '2. Relay the verdict (`approve`, `approve with notes`, `block`) back to the user in at most three lines.',
                  '3. If the verdict is `block`, do not keep implementing until you have addressed the finding or explained why it does not apply.',
                  '',
                  `Advisor contract to enforce:\n${ADVISOR_SYSTEM}`
                ].join('\n')
              )
            }
          })

          editor.add({
            name: 'panel',
            description:
              'Run an adversarial panel: the skeptic and the advisor review the same proposal, independently.',
            execute: async input => {
              // The proposal is the command argument. Refusing without it is the whole
              // point: the previous version built a review request around "the
              // proposal below" and, invoked bare, sent two reviewers nothing to
              // review.
              const proposal = (input.prompt?.text ?? '').trim()
              if (!proposal) {
                await send(input, 'Nothing to review. Usage: `/panel <proposal, plan, or diff>`.')
                return
              }

              const skeptic = state.resolved?.assignments.skeptic
              const advisor = state.resolved?.assignments.advisor
              const builder = state.resolved?.assignments.builder
              const key = (entry?: { model?: { providerID: string; id: string } }) =>
                entry?.model ? `${entry.model.providerID}/${entry.model.id}` : undefined
              const correlated = key(skeptic) && key(skeptic) === key(builder)
              const shared = key(skeptic) && key(skeptic) === key(advisor)
              const independence = correlated
                ? `WARNING: the skeptic is bound to the builder's model (${key(skeptic)}). Its verdict is the same weights reviewing their own proposal — read it as one opinion, not two.`
                : shared
                  ? `The skeptic shares the advisor's model (${key(skeptic)}) but runs at a different reasoning effort. Treat the two verdicts as correlated, not independent.`
                  : ''
              const signals = signalsFor(input.sessionID)

              // Dispatched here rather than delegated back to the builder.
              //
              // Two reasons, both learned from this command failing against the real
              // host. The builder's own `subagent` launch opens a child session, which
              // a free tier refuses — and asking the builder to route around that by
              // tool *name* is not something it reliably does, which is exactly what
              // the previous version asked for. Each `dispatchRole` opens an ordinary
              // session instead, which is the route that works.
              //
              // `Promise.all` is what makes the panel independent: both turns are in
              // flight before either reply exists, so neither reviewer can read the
              // other. Sequencing them, or folding one verdict into the second
              // prompt, would produce one opinion in two voices.
              // Two delegated reviewer turns per panel, whether or not either answers:
              // a panel that fails is the expensive one, so it cannot be the one
              // that goes uncounted.
              telemetry.recordPanel(2)
              const [skepticResult, advisorResult] = await Promise.all([
                dispatchRole('skeptic', proposal, input.sessionID),
                dispatchRole('advisor', proposal, input.sessionID)
              ])

              const section = (title: string, result: DelegationResult) =>
                result.ok
                  ? [`### ${title}`, '', (result.text ?? '').trim()].join('\n')
                  : [
                      `### ${title} — did not answer`,
                      '',
                      `${result.error ?? 'unknown error'} (${result.elapsedMs}ms)`,
                      '',
                      isFreeTierError(result.error)
                        ? 'This is a free-tier restriction: the session this plugin creates is rejected because it runs outside the OpenCode host app. The model works inside the TUI, but any programmatic session creation (including this panel) is blocked. Fix: pin a non-free-tier model for this role, or run the review in the TUI.'
                        : 'That reviewer ran over a session and returned no verdict. Read it as a missing opinion, not as agreement.'
                    ].join('\n')

              const missing = [skepticResult, advisorResult].filter(result => !result.ok).length
              const headline = missing
                ? `${missing} of 2 reviewers did not answer, so this is not a panel. Each section names what came back; the session itself is in the TUI.`
                : "Both reviewers answered. They ran independently and neither saw the other's verdict."

              await send(
                input,
                [
                  'Two independent reviews of the proposal below are already complete. Present them — do not re-run them.',
                  '',
                  headline,
                  ...(independence ? ['', independence] : []),
                  ...(signals?.length
                    ? ['', 'Session signals at review time:', ...signals.map(entry => `- ${entry}`)]
                    : []),
                  '',
                  section('Skeptic', skepticResult),
                  '',
                  section('Advisor', advisorResult),
                  '',
                  'Report the two above under their own headings. Do not merge them into one verdict and do not average them. Where they agree, say so once; where they disagree, name the disagreement — that is the finding worth the tokens. Then add one line of your own read and stop. The panel advises; it does not block and it does not decide for you.',
                  '',
                  `Proposal under review:\n${proposal}`
                ].join('\n')
              )
            }
          })

          if (options.selftest) {
            editor.add({
              name: 'orchestra-selftest',
              description: 'Check the role resolver against fixed catalogs.',
              execute: async input => {
                const result = await runSelfTest()
                await send(
                  input,
                  [
                    result.failed === 0
                      ? `Self-test passed: ${result.passed} fixtures. Report this in one line and stop.`
                      : `Self-test FAILED: ${result.failed} of ${result.passed + result.failed} fixtures. Report the failures verbatim and do not investigate them.`,
                    '',
                    '```',
                    ...result.lines,
                    '```'
                  ].join('\n')
                )
              }
            })
          }
        })
      }

      return () => {
        for (const timer of timers) clearTimeout(timer)
        for (const item of disposables) void item.dispose()
        fanout.reset('the plugin unloaded')
        void registration?.dispose()
        void modelRegistration?.dispose()
      }
    } catch (error) {
      for (const timer of timers) clearTimeout(timer)
      fanout.reset('the plugin failed to load')
      for (const item of disposables) void item.dispose()
      void registration?.dispose()
      void modelRegistration?.dispose()
      throw error
    }
  }
}
