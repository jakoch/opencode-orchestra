/**
 * Repetition circuit breaker. Two loops, because the remedies differ: a tool loop is the model
 * grinding on something that usually settles on its own, an output loop is the model echoing a
 * reminder instead of acting, and no amount of waiting helps that one.
 */

import { effectiveToolId } from './evidence'

export type LoopKind = 'tool' | 'output'

export const REPETITION_THRESHOLD = 3

/**
 * The refusal threshold. Above the reporting threshold, and below the point
 * where a genuinely stuck model has burned the session.
 *
 * Scoped to read-only tools in `plugin/index.ts` because refusing a fifth
 * failing test run would block the core loop this plugin exists to support,
 * while a redundant re-read costs almost nothing to the builder.
 */
export const REFUSAL_THRESHOLD = 5

const HISTORY_SIZE = 10

export const CIRCUIT_TTL_MS = 10 * 60 * 1000

/** A tool loop clears itself quickly; an output loop needs a human. */
export const RESET_TIMEOUT_MS: Record<LoopKind, number> = {
  tool: 30_000,
  output: 10 * 60_000
}

interface CircuitState {
  /** One entry per launch, digested with its arguments and status. */
  toolCalls: string[]
  outputDigests: string[]
  /**
   * Result digests of the launches in `toolCalls`, parallel to it. Only the
   * trailing run of confirmed entries counts as a loop — a launch whose result
   * never arrived cannot confirm the one before it.
   */
  confirmed: (string | undefined)[]
  open: boolean
  openedBy?: LoopKind
  trippedAt: number
  lastSeen: number
}

/** Order-sensitive digest (length + djb2). Equality is all we need. */
export function digest(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return `${text.length}:${hash >>> 0}`
}

/** One tool call: what was asked, and what came back. */
export interface ToolEvent {
  sessionID: string
  /** Effective tool name, without namespace. */
  tool: string
  /** The arguments. `read a` and `read b` are different calls. */
  input?: unknown
  /**
   * Whether the call succeeded. A failure that repeats because the work
   * repeats is the model's job (`prompts.ts` tells it to re-run a failing check),
   * so status is part of identity rather than noise.
   */
  status?: 'completed' | 'error'
  /**
   * A digest of what the call produced, or undefined when the host sent none.
   *
   * A missing result must **not** count as identical to another missing one:
   * that is what stops an older host from tripping a circuit on nothing.
   */
  result?: string
}

export interface OutputEvent {
  sessionID: string
  /** The assistant turn's text. */
  text: string
  /** True when the turn called at least one tool. */
  hadToolCall: boolean
}

export interface CircuitVerdict {
  open: boolean
  kind?: LoopKind
  remainingMs: number
  reason: string
  /**
   * Consecutive identical calls whose **results** also matched. Zero when the
   * circuit is closed, and the number the refusal is derived from — not
   * `open`, which a timeout would clear under a model that is still stuck.
   */
  confirmedRepeats: number
}

export class RepetitionGuard {
  private readonly sessions = new Map<string, CircuitState>()
  private readonly ttlMs: number
  private readonly threshold: number
  /** Effective tool names the refusal applies to; undefined means every tool. */
  private refusalTools: ReadonlySet<string> | undefined
  private readonly refusalThreshold: number

  constructor(
    options: {
      ttlMs?: number
      threshold?: number
      /** Refusal threshold. Defaults to `REFUSAL_THRESHOLD`. */
      refusalThreshold?: number
      /** Tools the refusal applies to. Empty means no refusal, by design. */
      refusalTools?: readonly string[]
    } = {}
  ) {
    this.ttlMs = options.ttlMs ?? CIRCUIT_TTL_MS
    this.threshold = options.threshold ?? REPETITION_THRESHOLD
    this.refusalThreshold = options.refusalThreshold ?? REFUSAL_THRESHOLD
    this.refusalTools = options.refusalTools?.length ? new Set(options.refusalTools.map(effectiveToolId)) : undefined
  }

  private state(sessionID: string): CircuitState {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = { toolCalls: [], outputDigests: [], confirmed: [], open: false, trippedAt: 0, lastSeen: Date.now() }
      this.sessions.set(sessionID, state)
    }
    return state
  }

  /**
   * What was *asked*: the tool and its arguments, deliberately not the outcome.
   *
   * `read a` and `read b` are different calls, and `bun test` / `tsc --noEmit` /
   * `biome check .` are three different calls even though `prompts.ts:67` tells
   * the builder to run exactly that sequence. That was the original bug: the
   * guard compared bare tool names.
   */
  private identity(tool: string, input: unknown): string {
    let args = ''
    try {
      args = input === undefined ? '' : (JSON.stringify(input) ?? '')
    } catch {
      // Unserializable arguments must not exempt a call from the check.
      args = 'unserializable'
    }
    return digest(`${effectiveToolId(tool)}\u0000${args}`)
  }

  /**
   * How it *ended*, or `undefined` when the host sent no result at all.
   *
   * `undefined` is the load-bearing part: an older host that reports no result
   * cannot confirm anything, so it must never trip a circuit on nothing. Status
   * is folded in so a failing call is not "the same" as a succeeding one — and
   * so `bun test` failing three times is not reported as the model looping.
   */
  private outcome(event: ToolEvent): string | undefined {
    if (event.result === undefined) return undefined
    return digest(`${event.status ?? 'completed'}\u0000${event.result}`)
  }

  /** The trailing run of launches that are identical *and* confirmed by their results. */
  private confirmedRepeats(state: CircuitState): number {
    const count = Math.min(state.toolCalls.length, state.confirmed.length)
    if (!count) return 0
    const lastOutcome = state.confirmed[count - 1]
    // No result yet: the run is unconfirmed, so it is not a repetition.
    if (lastOutcome === undefined) return 0
    const lastIdentity = state.toolCalls[count - 1]
    let repeats = 0
    for (let index = count - 1; index >= 0; index--) {
      if (state.toolCalls[index] !== lastIdentity || state.confirmed[index] !== lastOutcome) break
      repeats++
    }
    return repeats
  }

  private verdict(state: CircuitState, now: number): CircuitVerdict {
    if (!state.open || !state.openedBy) return { open: false, remainingMs: 0, reason: '', confirmedRepeats: 0 }
    const resetAfter = RESET_TIMEOUT_MS[state.openedBy]
    const elapsed = now - state.trippedAt
    if (elapsed >= resetAfter) {
      state.open = false
      state.openedBy = undefined
      state.toolCalls = []
      state.outputDigests = []
      state.confirmed = []
      return { open: false, remainingMs: 0, reason: '', confirmedRepeats: 0 }
    }
    const reason =
      state.openedBy === 'tool'
        ? `${this.threshold} identical calls with identical results in a row`
        : `${this.threshold} identical tool-free turns in a row`
    return {
      open: true,
      kind: state.openedBy,
      remainingMs: resetAfter - elapsed,
      reason,
      confirmedRepeats: this.confirmedRepeats(state)
    }
  }

  /** Call after every completed tool call; use `peek` for display. */
  recordTool(event: ToolEvent, now = Date.now()): CircuitVerdict {
    const state = this.state(event.sessionID)
    state.lastSeen = now
    // An already-expired circuit is cleared here, before anything is recorded,
    // so a stale `open` cannot swallow this launch.
    this.verdict(state, now)

    state.toolCalls.push(this.identity(event.tool, event.input))
    state.confirmed.push(this.outcome(event))
    if (state.toolCalls.length > HISTORY_SIZE) {
      state.toolCalls.shift()
      state.confirmed.shift()
    }

    // Recording deliberately continues while the circuit is open, because that
    // is what makes the refusal threshold reachable at all: the confirmed count
    // has to climb from the reporting threshold of 3 to the refusal threshold
    // of 5. Tripping, by contrast, happens once - re-stamping `trippedAt` on
    // every call would slide the 30s auto-clear forward forever.
    const repeats = this.confirmedRepeats(state)
    if (!state.open && repeats >= this.threshold) {
      state.open = true
      state.openedBy = 'tool'
      state.trippedAt = now
    }
    return this.verdict(state, now)
  }

  recordOutput(event: OutputEvent, now = Date.now()): CircuitVerdict {
    const state = this.state(event.sessionID)
    state.lastSeen = now
    if (state.open) return this.verdict(state, now)

    if (event.hadToolCall) {
      // Real work resets the output signal: the model is acting again.
      state.outputDigests = []
      return this.verdict(state, now)
    }

    const trimmed = event.text.trim()
    if (!trimmed) {
      state.outputDigests = []
      return this.verdict(state, now)
    }

    state.outputDigests.push(digest(trimmed))
    if (state.outputDigests.length > HISTORY_SIZE) state.outputDigests.shift()
    const last = state.outputDigests.slice(-this.threshold)
    if (last.length === this.threshold && last.every(entry => entry === last[0])) {
      state.open = true
      state.openedBy = 'output'
      state.trippedAt = now
    }
    return this.verdict(state, now)
  }

  /**
   * Reads the circuit without touching it.
   *
   * The read used to write `lastSeen`, which kept a session alive forever for
   * as long as anything displayed its circuit — a report against an old
   * session kept that state alive in the prune loop indefinitely.
   */
  peek(sessionID: string, now = Date.now()): CircuitVerdict {
    const state = this.sessions.get(sessionID)
    if (!state) return { open: false, remainingMs: 0, reason: '', confirmedRepeats: 0 }
    // A copy, because `verdict` clears an expired circuit and reading is not
    // a decision to reset it.
    const snapshot: CircuitState = {
      ...state,
      toolCalls: [...state.toolCalls],
      outputDigests: [...state.outputDigests],
      confirmed: [...state.confirmed]
    }
    return this.verdict(snapshot, now)
  }

  /** A real user turn clears an open circuit immediately. */
  acknowledge(sessionID: string): void {
    const state = this.sessions.get(sessionID)
    if (!state) return
    state.open = false
    state.openedBy = undefined
    state.toolCalls = []
    state.outputDigests = []
    state.confirmed = []
  }

  /**
   * Whether a launch of this tool should be refused right now.
   *
   * Derived from the confirmed repeat count and never from `open`: the tool
   * circuit auto-clears after 30s, so an `open`-derived refusal would expire
   * on exactly the sessions that still need it.
   *
   * Takes the *pending* launch, which is all `execute.before` carries. The SDK
   * sends `{ tool, sessionID, agent, messageID, id, input }` there and no
   * `status` and no result, so status deliberately plays no part here: the
   * outcome is what `recordTool` recorded when the *previous* identical calls
   * ran, and the question here is only whether this call is one of them.
   */
  decide(event: { sessionID: string; tool: string; input?: unknown }, now = Date.now()): boolean {
    if (this.refusalTools && !this.refusalTools.has(effectiveToolId(event.tool))) return false
    const state = this.sessions.get(event.sessionID)
    if (!state) return false
    const count = Math.min(state.toolCalls.length, state.confirmed.length)
    // Nothing recorded yet, or the most recent call is a different one: this
    // launch is not extending a run, so there is nothing to refuse.
    if (!count || state.toolCalls[count - 1] !== this.identity(event.tool, event.input)) return false
    return this.confirmedRepeats(state) >= this.refusalThreshold
  }

  openCount(now = Date.now()): number {
    let count = 0
    for (const [sessionID, state] of this.sessions) {
      if (this.verdict(state, now).open) count++
    }
    return count
  }

  prune(now = Date.now()): void {
    for (const [sessionID, state] of this.sessions) {
      if (now - state.lastSeen > this.ttlMs) this.sessions.delete(sessionID)
    }
  }
}

export function describeCircuit(verdict: CircuitVerdict): string {
  if (!verdict.open) return ''
  const seconds = Math.ceil(verdict.remainingMs / 1000)
  const wait = seconds > 90 ? `${Math.round(seconds / 60)} min` : `${seconds}s`
  return `Repetition guard is open: ${verdict.reason}. This circuit closes itself after ${wait}; ask the user before continuing rather than retrying.`
}

/**
 * The tools the refusal covers.
 *
 * Named explicitly rather than derived from `READ_ONLY_PERMISSIONS`, which
 * would drag in `webfetch`: refusing a fifth failing test run would block the
 * core loop the plugin exists to support, and the read-only roles cannot reach
 * a write tool anyway, so this only ever binds the builder — where a redundant
 * re-read is the near-zero-cost false positive.
 */
export const REFUSAL_TOOLS = ['read', 'grep', 'glob'] as const

/**
 * The plugin's own delegation tools, which the guard must never count.
 *
 * The builder prompt tells the model to call `orchestra_scout` repeatedly, so
 * three delegations in a row would otherwise trip a circuit describing the
 * plugin working. Shared with `FanoutAdmission` so the two cannot drift.
 */
export const DELEGATION_TOOLS = ['subagent', 'scout', 'advisor', 'skeptic'] as const
