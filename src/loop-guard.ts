/**
 * Repetition circuit breaker.
 *
 * Two distinct loops, detected separately because they need different remedies.
 *
 * **Tool loop** — the same tool called three times running, usually the same
 * failing test. The model is grinding, not thinking. A short pause is enough,
 * because whatever it was retrying usually settles on its own.
 *
 * **Output loop** — three consecutive completed turns with no tool call and
 * identical text. This is a model echoing a system reminder instead of acting.
 * No amount of waiting helps, so it needs the user, and the pause is long.
 *
 * State is per session and cheap: consecutive-equality only needs a digest, not
 * the transcript.
 */

export type LoopKind = "tool" | "output"

/** Consecutive identical events before the circuit opens. */
export const REPETITION_THRESHOLD = 3

/** How many recent digests to keep per signal. */
const HISTORY_SIZE = 10

/** Forget state for sessions we have not touched in this long. */
export const CIRCUIT_TTL_MS = 10 * 60 * 1000

/** A tool loop clears itself quickly; an output loop needs a human. */
export const RESET_TIMEOUT_MS: Record<LoopKind, number> = {
  tool: 30_000,
  output: 10 * 60_000,
}

interface CircuitState {
  toolCalls: string[]
  outputDigests: string[]
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

export interface ToolEvent {
  sessionID: string
  /** Effective tool name, without namespace. */
  tool: string
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
  /** Milliseconds until the circuit closes itself. */
  remainingMs: number
  reason: string
}

export class RepetitionGuard {
  private readonly sessions = new Map<string, CircuitState>()
  private readonly ttlMs: number
  private readonly threshold: number

  constructor(options: { ttlMs?: number; threshold?: number } = {}) {
    this.ttlMs = options.ttlMs ?? CIRCUIT_TTL_MS
    this.threshold = options.threshold ?? REPETITION_THRESHOLD
  }

  private state(sessionID: string): CircuitState {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = { toolCalls: [], outputDigests: [], open: false, trippedAt: 0, lastSeen: Date.now() }
      this.sessions.set(sessionID, state)
    }
    return state
  }

  private verdict(state: CircuitState, now: number): CircuitVerdict {
    if (!state.open || !state.openedBy) return { open: false, remainingMs: 0, reason: "" }
    const resetAfter = RESET_TIMEOUT_MS[state.openedBy]
    const elapsed = now - state.trippedAt
    if (elapsed >= resetAfter) {
      state.open = false
      state.openedBy = undefined
      state.toolCalls = []
      state.outputDigests = []
      return { open: false, remainingMs: 0, reason: "" }
    }
    const reason =
      state.openedBy === "tool"
        ? `the same tool was called ${this.threshold} times in a row`
        : `${this.threshold} identical tool-free turns in a row`
    return { open: true, kind: state.openedBy, remainingMs: resetAfter - elapsed, reason }
  }

  /** Call after every completed tool call. Prefer `peek` for display. */
  recordTool(event: ToolEvent, now = Date.now()): CircuitVerdict {
    const state = this.state(event.sessionID)
    state.lastSeen = now
    if (state.open) return this.verdict(state, now)

    state.toolCalls.push(event.tool)
    if (state.toolCalls.length > HISTORY_SIZE) state.toolCalls.shift()
    const last = state.toolCalls.slice(-this.threshold)
    if (last.length === this.threshold && last.every((tool) => tool === last[0])) {
      state.open = true
      state.openedBy = "tool"
      state.trippedAt = now
    }
    return this.verdict(state, now)
  }

  /** Call after every completed assistant turn. */
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
    if (last.length === this.threshold && last.every((entry) => entry === last[0])) {
      state.open = true
      state.openedBy = "output"
      state.trippedAt = now
    }
    return this.verdict(state, now)
  }

  /** Current state without recording anything. */
  peek(sessionID: string, now = Date.now()): CircuitVerdict {
    const state = this.sessions.get(sessionID)
    if (!state) return { open: false, remainingMs: 0, reason: "" }
    state.lastSeen = now
    return this.verdict(state, now)
  }

  /** A real user turn clears an open circuit immediately. */
  acknowledge(sessionID: string): void {
    const state = this.sessions.get(sessionID)
    if (!state) return
    state.open = false
    state.openedBy = undefined
    state.toolCalls = []
    state.outputDigests = []
  }

  /** Total circuits currently open, across all sessions. */
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

/** One line to append to a system prompt or a report. */
export function describeCircuit(verdict: CircuitVerdict): string {
  if (!verdict.open) return ""
  const seconds = Math.ceil(verdict.remainingMs / 1000)
  const wait = seconds > 90 ? `${Math.round(seconds / 60)} min` : `${seconds}s`
  return `Repetition guard is open: ${verdict.reason}. Auto-clears in ${wait}. Ask the user before continuing rather than retrying.`
}