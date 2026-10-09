/**
 * Context window awareness.
 *
 * The host knows each model's real context limit; anything that assumes a fixed
 * window is wrong for 1M-token models, which then get "near limit" warnings at a
 * fraction of their capacity. This resolves the limit per model and tracks usage
 * so the builder can be warned at the right threshold for the model it is
 * actually running on.
 *
 * Usage comes from the assistant messages the session reports. It is an estimate
 * from reported token counts, not a tokenizer, so thresholds are deliberately
 * conservative.
 */

export interface ModelContextLimits {
  /** `provider/model` → context window in tokens. */
  readonly [ref: string]: number
}

/** Used when neither the option nor the catalog says anything. */
export const DEFAULT_CONTEXT_LIMIT = 200_000

/** Warn at this fraction of the window. */
export const DEFAULT_WARN_RATIO = 0.85

/** Nothing is known about a model until it has been seen in a request. */
const UNKNOWN = { limit: DEFAULT_CONTEXT_LIMIT, known: false }

export interface ContextOptions {
  /** Explicit override for every model, from plugin options. */
  overrideMaxTokens?: number
  /** Fraction of the window at which to warn. */
  warnRatio?: number
}

/**
 * One request's reported usage, as the host bills it.
 *
 * `input`/`output`/`reasoning` and the cache counters answer different questions:
 * occupancy is what the model must hold in its window, cost is what you are
 * billed. Cached reads are resident context but nearly free, so both views are
 * kept rather than collapsed into one number.
 */
export interface RequestUsage {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface ContextReading {
  limit: number
  known: boolean
  /** Tokens resident in the window: uncached prompt + cached prompt + output. */
  occupancy?: number
  /** What the request actually cost in prompt tokens, ignoring cache reuse. */
  billable?: number
  ratio?: number
  /** True once occupancy passes the warn threshold. */
  warning: boolean
  /** True once the session is close enough that compaction is likely. */
  critical: boolean
  /** Plain-language note for a prompt or report, when there is something to say. */
  note?: string
}

/** Uncached prompt plus this turn's generated tokens. */
export function billableTokens(usage: RequestUsage): number {
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.reasoning ?? 0)
}

/**
 * Tokens the model must hold. Cached prompt tokens still occupy the window even
 * though they are billed at a discount, so they count here and nowhere else.
 */
export function occupancyTokens(usage: RequestUsage): number {
  return billableTokens(usage) + (usage.cache?.read ?? 0) + (usage.cache?.write ?? 0)
}

export class ContextMonitor {
  private readonly limits = new Map<string, number>()
  /** Session → the model it last ran on. */
  private readonly modelBySession = new Map<string, string>()
  /**
   * Session → high-water mark of prompt occupancy.
   *
   * Each request reports its own usage, and later turns in a session are largely
   * cache hits, so the newest message is not the window size. Occupancy only
   * grows within a session, so the maximum across requests is the best estimate
   * available without a tokenizer.
   */
  private readonly peakBySession = new Map<string, number>()
  private readonly warnRatio: number
  private readonly override?: number

  constructor(options: ContextOptions = {}) {
    this.warnRatio = options.warnRatio ?? DEFAULT_WARN_RATIO
    if (options.overrideMaxTokens && options.overrideMaxTokens > 0) {
      this.override = options.overrideMaxTokens
    }
  }

  /** Seeds limits from the catalog, so a model is known before it is used. */
  seed(entries: Iterable<{ ref: string; context?: number }>): void {
    for (const entry of entries) {
      if (entry.context && entry.context > 0) this.limits.set(entry.ref, entry.context)
    }
  }

  /** Records the model a session is running, as observed on a request. */
  rememberModel(sessionID: string, providerID: string, modelID: string): void {
    if (!providerID || !modelID) return
    this.modelBySession.set(sessionID, `${providerID}/${modelID}`)
  }

  limitFor(providerID: string, modelID: string): { limit: number; known: boolean } {
    if (this.override) return { limit: this.override, known: true }
    const known = this.limits.get(`${providerID}/${modelID}`)
    return known ? { limit: known, known: true } : UNKNOWN
  }

  /**
   * Folds one request's usage into the session estimate and reads the result.
   * Call this for every request; the reading uses the high-water mark.
   */
  observe(sessionID: string, usage: RequestUsage): ContextReading {
    const occupancy = occupancyTokens(usage)
    const billable = billableTokens(usage)
    if (Number.isFinite(occupancy) && occupancy > 0) {
      const peak = this.peakBySession.get(sessionID) ?? 0
      if (occupancy > peak) this.peakBySession.set(sessionID, occupancy)
    }
    return this.read(sessionID)
  }

  /**
   * Reads pressure for a session. Use `observe` first to feed usage; calling
   * this alone reports occupancy only if something has already been observed.
   */
  read(sessionID: string): ContextReading {
    const ref = this.modelBySession.get(sessionID)
    const { limit, known } = ref
      ? this.limitFor(ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1))
      : UNKNOWN

    const occupancy = this.peakBySession.get(sessionID)
    if (occupancy === undefined || occupancy <= 0) {
      return { limit, known, warning: false, critical: false }
    }

    const ratio = occupancy / limit
    const warning = ratio >= this.warnRatio
    const critical = ratio >= 0.95
    const reading: ContextReading = {
      limit,
      known,
      occupancy,
      billable: this.peakBySession.get(sessionID),
      ratio,
      warning,
      critical,
    }
    if (warning) reading.note = this.note(occupancy, limit, ratio, known)
    return reading
  }

  private note(occupancy: number, limit: number, ratio: number, known: boolean): string {
    const percent = Math.round(ratio * 100)
    const detail = known
      ? `~${formatTokens(occupancy)} of ${formatTokens(limit)} tokens occupied (${percent}%).`
      : `~${formatTokens(occupancy)} tokens occupied; the limit for this model is unknown, assuming ${formatTokens(DEFAULT_CONTEXT_LIMIT)}.`
    const advice =
      ratio >= 0.95
        ? " Compact now or work will be truncated. Summarize what matters and drop the file dumps."
        : " Keep tool output small, summarize long reads, and checkpoint decisions before they scroll out."
    return `Context ${percent}% full. ${detail}${advice}`
  }

  /** Drops a session's state, for use after a compaction reset. */
  forget(sessionID: string): void {
    this.modelBySession.delete(sessionID)
    this.peakBySession.delete(sessionID)
  }

  /** Drops session state we have not refreshed recently. */
  prune(activeSessionIDs: Iterable<string>): void {
    const active = new Set(activeSessionIDs)
    for (const sessionID of [...this.modelBySession.keys()]) {
      if (!active.has(sessionID)) this.forget(sessionID)
    }
    for (const sessionID of [...this.peakBySession.keys()]) {
      if (!active.has(sessionID)) this.peakBySession.delete(sessionID)
    }
  }
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(Math.round(value))
}