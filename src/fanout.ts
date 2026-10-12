/**
 * Subagent fan-out admission. Permissions gate *which* agent, not how many at once,
 * so the cap lives in the tool hook. Excess launches queue; only one that cannot get
 * a slot in time is refused, and it is refused with a message the model can act on.
 */

import { effectiveToolId } from './evidence'
import type { GateDimension } from './telemetry'

export interface FanoutOptions {
  /**
   * Bounds one backend, across sessions; the session cap bounds one caller. Two
   * sessions within their own limits can still collide on the same model.
   */
  modelLimit?: number
  /**
   * Bounds one provider runtime, across sessions and models. Only configured
   * providers are capped; the rest are unbounded. Keyed on `providerID` — not
   * `package` (every local endpoint shares one implementation library) and not
   * `baseURL` (fragile string equality on possibly-credentialed endpoints).
   */
  providerConcurrency?: Record<string, number>
  limit?: number
  acquireTimeoutMs?: number
  leaseMs?: number
  now?: () => number
}

export interface Admission {
  ok: boolean
  slotId?: string
  waitedMs: number
  refused?: string
  inFlight: number
}

interface Slot {
  id: string
  takenAt: number
}

interface Waiter {
  resolve: (admission: Admission) => void
  startedAt: number
  timer?: ReturnType<typeof setTimeout>
}

const DEFAULT_LIMIT = 2
const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000
const DEFAULT_LEASE_MS = 10 * 60_000

export class FanoutGate {
  private readonly slots = new Map<string, Slot[]>()
  private readonly waiters = new Map<string, Waiter[]>()
  /** At most one pending lease reap per key, so N waiters cost one timer. */
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly limit: number
  private readonly acquireTimeoutMs: number
  private readonly leaseMs: number
  private readonly now: () => number
  /** What the refusal names as the contended dimension: session, model, provider. */
  private readonly scope: string

  constructor(options: FanoutOptions = {}, scope = 'per session') {
    this.limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT))
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.now = options.now ?? Date.now
    this.scope = scope
  }

  /** Reaps slots whose call never reported back, so a crashed child cannot leak one. */
  private reap(key: string): Slot[] {
    const held = this.slots.get(key) ?? []
    if (!held.length) return held
    const now = this.now()
    // A slot is live for its lease and not a millisecond past it. Stated as an
    // age comparison because `takenAt >= cutoff` reads as "reap what is older"
    // while actually keeping a slot alive *through* its own lease age.
    const live = held.filter(slot => now - slot.takenAt < this.leaseMs)
    if (live.length !== held.length) this.slots.set(key, live)
    return live
  }

  private wake(key: string): void {
    const queue = this.waiters.get(key)
    if (!queue?.length) return
    // Whoever woke this key re-arms on the way out if the queue survived it.
    const armed = this.reapTimers.get(key)
    if (armed) {
      clearTimeout(armed)
      this.reapTimers.delete(key)
    }
    const held = this.reap(key)
    while (queue.length && held.length < this.limit) {
      const waiter = queue.shift()!
      if (waiter.timer) clearTimeout(waiter.timer)
      const takenAt = this.now()
      const slot: Slot = { id: `slot-${takenAt}-${held.length}`, takenAt }
      held.push(slot)
      waiter.resolve({
        ok: true,
        slotId: slot.id,
        waitedMs: takenAt - waiter.startedAt,
        inFlight: held.length
      })
    }
    this.slots.set(key, held)
    if (!queue.length) this.waiters.delete(key)
  }

  /** Resolves with `ok: false` rather than throwing, so the caller chooses how to surface a refusal. */
  acquire(key: string, label?: string): Promise<Admission> {
    const startedAt = this.now()
    const held = this.reap(key)
    if (held.length < this.limit) {
      const slot: Slot = { id: `slot-${startedAt}-${held.length}`, takenAt: startedAt }
      held.push(slot)
      this.slots.set(key, held)
      return Promise.resolve({ ok: true, slotId: slot.id, waitedMs: 0, inFlight: held.length })
    }

    return new Promise<Admission>(resolve => {
      const queue = this.waiters.get(key) ?? []
      const waiter: Waiter = { resolve, startedAt }
      waiter.timer = setTimeout(() => {
        const current = this.waiters.get(key) ?? []
        const index = current.indexOf(waiter)
        if (index >= 0) current.splice(index, 1)
        // The last one out turns the light off: a reap timer outliving its queue
        // would fire into an empty key and re-arm against nothing.
        if (!current.length) {
          this.waiters.delete(key)
          const armed = this.reapTimers.get(key)
          if (armed) {
            clearTimeout(armed)
            this.reapTimers.delete(key)
          }
        }
        resolve({
          ok: false,
          waitedMs: this.now() - startedAt,
          refused:
            `The orchestra allows ${this.limit} concurrent subagent call(s) ${this.scope} and all ` +
            `${this.limit} are busy${label ? ` (launching "${label}")` : ''}. ` +
            `Work on the results you already have, then launch the next one — or narrow the request so one call answers it.`,
          inFlight: this.reap(key).length
        })
      }, this.acquireTimeoutMs)
      queue.push(waiter)
      this.waiters.set(key, queue)
      // A queued waiter has no other way to learn that a slot came back. `wake` is
      // reached from `release`, so without this a waiter behind a *crashed* holder
      // — the one case the lease exists to handle — sat until its own acquire
      // timeout, reporting a busy limit that had in fact lapsed. One timer per key,
      // cleared as soon as the queue drains.
      this.scheduleReap(key)
    })
  }

  /** Wakes the key's waiters once the oldest held slot ages out, so a lease reap reaches the queue rather than only the count. */
  private scheduleReap(key: string): void {
    if (this.reapTimers.has(key)) return
    const held = this.slots.get(key) ?? []
    const oldest = held.reduce((min, slot) => Math.min(min, slot.takenAt), Number.POSITIVE_INFINITY)
    // Nothing held: a slot is free and `acquire` would not have queued. Timer
    // unref'd so a pending reap cannot hold the process open on its own.
    if (!Number.isFinite(oldest)) return
    const delay = Math.max(0, oldest + this.leaseMs - this.now())
    const timer = setTimeout(() => {
      this.reapTimers.delete(key)
      this.wake(key)
    }, delay)
    if (typeof timer === 'object' && timer.unref) timer.unref()
    this.reapTimers.set(key, timer)
  }

  release(key: string, slotId?: string): void {
    const held = this.reap(key)
    if (!held.length) return
    if (slotId) {
      const index = held.findIndex(slot => slot.id === slotId)
      if (index >= 0) held.splice(index, 1)
    } else {
      held.pop()
    }
    this.slots.set(key, held)
    this.wake(key)
  }

  inFlight(key: string): number {
    return this.reap(key).length
  }

  queued(key: string): number {
    return this.waiters.get(key)?.length ?? 0
  }

  /**
   * Pending waiters are refused rather than left hanging, so a plugin unload cannot
   * strand an awaited hook forever.
   */
  reset(reason = 'the plugin unloaded'): void {
    for (const [key, queue] of this.waiters) {
      for (const waiter of queue) {
        if (waiter.timer) clearTimeout(waiter.timer)
        waiter.resolve({
          ok: false,
          waitedMs: this.now() - waiter.startedAt,
          refused: `Waiting for a subagent slot ended because ${reason}.`,
          inFlight: 0
        })
      }
    }
    this.waiters.clear()
    this.slots.clear()
    // Cleared after the waiters, so nothing can re-arm during the loop above.
    for (const timer of this.reapTimers.values()) clearTimeout(timer)
    this.reapTimers.clear()
  }
}

/** Default limits, exported so the report can state them. */
export const FANOUT_DEFAULTS = {
  limit: DEFAULT_LIMIT,
  acquireTimeoutMs: DEFAULT_ACQUIRE_TIMEOUT_MS,
  leaseMs: DEFAULT_LEASE_MS
}

/**
 * A refusal, carrying which dimension refused it.
 *
 * The dimension rides on the error rather than being recovered from the
 * message: callers count refusals per gate, and matching prose to work out
 * which of three fired is how a reworded string silently zeroes a counter. The
 * message itself is unchanged.
 */
export interface FanoutRefusal extends Error {
  readonly fanoutDimension: GateDimension
}

function refusal(dimension: GateDimension, message: string | undefined): FanoutRefusal {
  const error = new Error(`orchestra: ${message}`) as FanoutRefusal
  Object.defineProperty(error, 'fanoutDimension', { value: dimension, enumerable: true })
  return error
}

/** A host tool call, as the `execute.before` / `execute.after` hooks report it. */
export interface FanoutCall {
  /**
   * Omitted by some hosts, and then there is no key to correlate a completion on —
   * which is what `FanoutAdmission` exists to absorb.
   */
  id?: string
  sessionID: string
  tool: string
  input?: unknown
  /**
   * Roles can share a model (the resolver reports that as `sharedWith`), and two
   * agents on one backend contend for it with nothing surfacing it.
   */
  model?: string
}

/**
 * A slot that cannot be given back is worse than no slot: the session stays at its
 * limit until the lease reaps it. So one completion frees exactly one slot, only for
 * the gated tool, and an id-less launch is matched by position.
 */
export class FanoutAdmission {
  private readonly gate: FanoutGate
  private readonly tools: ReadonlySet<string>
  private readonly enabled: boolean
  private readonly slotByCall = new Map<string, { sessionID: string; slotId: string }>()
  private readonly untracked = new Map<string, number>()

  /**
   * The same gate, keyed on the model: two sessions within their own limits
   * can still collide on one backend.
   */
  private readonly modelGate: FanoutGate | undefined
  private readonly modelSlotByCall = new Map<string, { model: string; slotId: string }>()
  private readonly modelUntracked = new Map<string, number>()

  /**
   * One gate per configured provider, built lazily: N children on one local
   * box contend for a single accelerator and KV pool however many sessions or
   * models they are spread over. Unconfigured providers have no gate and are
   * unbounded.
   */
  private readonly providerLimits: Record<string, number>
  private readonly providerGates = new Map<string, FanoutGate>()
  private readonly providerSlotByCall = new Map<string, { provider: string; slotId: string }>()
  private readonly providerUntracked = new Map<string, number>()
  private readonly gateOptions: Pick<FanoutOptions, 'acquireTimeoutMs' | 'leaseMs' | 'now'>

  // `readonly` so a shared frozen constant (`DELEGATION_TOOLS`) can be passed
  // straight in rather than copied at every call site.
  constructor(options: FanoutOptions & { tool?: string | readonly string[] } = {}) {
    this.gate = new FanoutGate(options)
    // `FanoutGate` clamps a limit of 0 up to 1 because it always has a caller; a
    // disabled gate has none, so the off switch is held here instead.
    this.enabled = (options.limit ?? DEFAULT_LIMIT) > 0
    this.tools = new Set(
      (Array.isArray(options.tool) ? options.tool : [options.tool ?? 'subagent']).map(
        // Effective form, because that is what a namespaced call reduces to:
        // `orchestra_scout` and a bare `scout` are one gate entry, not two.
        tool => effectiveToolId(tool)
      )
    )
    const modelLimit = options.modelLimit ?? 0
    this.modelGate = modelLimit > 0 ? new FanoutGate({ ...options, limit: modelLimit }, 'per model') : undefined
    this.providerLimits = { ...(options.providerConcurrency ?? {}) }
    this.gateOptions = { acquireTimeoutMs: options.acquireTimeoutMs, leaseMs: options.leaseMs, now: options.now }
  }

  modelInFlight(model: string): number {
    return this.modelGate?.inFlight(model) ?? 0
  }

  providerInFlight(provider: string): number {
    return this.providerGates.get(provider)?.inFlight(provider) ?? 0
  }

  private counts(event: FanoutCall): boolean {
    return this.enabled && this.tools.has(effectiveToolId(event.tool))
  }

  /**
   * Waits for a slot and blocks the call by throwing when none arrives, which is how
   * the refusal reaches the model as something it can act on.
   */
  async admit(event: FanoutCall): Promise<void> {
    if (!this.counts(event)) return
    const agent = (event.input as { agent?: string } | undefined)?.agent
    const admission = await this.gate.acquire(event.sessionID, agent)
    if (!admission.ok) throw refusal('session', admission.refused)
    // A slot the gate cannot name cannot be released later, so record nothing: a
    // phantom entry would free a slot this launch never took.
    if (!admission.slotId) return

    // Ordered most specific last: each level holds what it took while queueing
    // for the next, and a refusal unwinds everything already held, so a call
    // refused on one dimension never wedges another.
    const modelSlot = await this.acquireModelSlot(event, admission.slotId)
    const providerSlot = await this.acquireProviderSlot(event, admission.slotId, modelSlot)
    if (event.id) {
      this.slotByCall.set(event.id, { sessionID: event.sessionID, slotId: admission.slotId })
      if (modelSlot) this.modelSlotByCall.set(event.id, modelSlot)
      if (providerSlot) this.providerSlotByCall.set(event.id, providerSlot)
      return
    }
    this.untracked.set(event.sessionID, (this.untracked.get(event.sessionID) ?? 0) + 1)
    if (modelSlot) this.modelUntracked.set(modelSlot.model, (this.modelUntracked.get(modelSlot.model) ?? 0) + 1)
    if (providerSlot)
      this.providerUntracked.set(providerSlot.provider, (this.providerUntracked.get(providerSlot.provider) ?? 0) + 1)
  }

  /** The provider a launch runs against, from the `providerID/id` model ref. */
  private providerOf(event: FanoutCall): string | undefined {
    if (!event.model) return undefined
    const slash = event.model.indexOf('/')
    return slash < 0 ? event.model : event.model.slice(0, slash)
  }

  private providerGate(provider: string): FanoutGate | undefined {
    const limit = this.providerLimits[provider]
    if (limit === undefined || limit <= 0) return undefined
    let gate = this.providerGates.get(provider)
    if (!gate) {
      gate = new FanoutGate({ ...this.gateOptions, limit }, 'per provider')
      this.providerGates.set(provider, gate)
    }
    return gate
  }

  /**
   * A refusal is a refusal: the session slot is already held, so it is given back
   * before throwing, or the caller would be wedged at its session limit forever.
   */
  private async acquireModelSlot(
    event: FanoutCall,
    sessionSlotId: string
  ): Promise<{ model: string; slotId: string } | undefined> {
    const gate = this.modelGate
    const model = event.model
    if (!gate || !model) return undefined

    const agent = (event.input as { agent?: string } | undefined)?.agent
    const admission = await gate.acquire(model, agent)
    if (!admission.ok) {
      // Give the SESSION slot back through the SESSION gate: releasing against the
      // model gate would free an unrelated model's slot and wedge this session.
      this.gate.release(event.sessionID, sessionSlotId)
      throw refusal('model', admission.refused)
    }
    return admission.slotId ? { model, slotId: admission.slotId } : undefined
  }

  /**
   * Same discipline one dimension further out: a provider refusal unwinds the
   * model slot through the model gate and the session slot through the session
   * gate, each to its own dimension, so no wedge is left anywhere.
   */
  private async acquireProviderSlot(
    event: FanoutCall,
    sessionSlotId: string,
    modelSlot: { model: string; slotId: string } | undefined
  ): Promise<{ provider: string; slotId: string } | undefined> {
    const provider = this.providerOf(event)
    const gate = provider ? this.providerGate(provider) : undefined
    if (!gate || !provider) return undefined

    const agent = (event.input as { agent?: string } | undefined)?.agent
    const admission = await gate.acquire(provider, agent)
    if (!admission.ok) {
      if (modelSlot && event.model) this.modelGate?.release(event.model, modelSlot.slotId)
      this.gate.release(event.sessionID, sessionSlotId)
      throw refusal('provider', admission.refused)
    }
    return admission.slotId ? { provider, slotId: admission.slotId } : undefined
  }

  /** Frees the slot a completed call held, when the call can be identified. */
  release(event: FanoutCall): void {
    if (!this.counts(event)) return
    if (event.id) {
      const held = this.slotByCall.get(event.id)
      if (!held) return
      this.slotByCall.delete(event.id)
      this.gate.release(held.sessionID, held.slotId)
      // Every dimension together, or a cap leaks a slot per completed call
      // and eventually refuses everything.
      const modelHeld = this.modelSlotByCall.get(event.id)
      if (modelHeld) {
        this.modelSlotByCall.delete(event.id)
        this.modelGate?.release(modelHeld.model, modelHeld.slotId)
      }
      const providerHeld = this.providerSlotByCall.get(event.id)
      if (providerHeld) {
        this.providerSlotByCall.delete(event.id)
        this.providerGates.get(providerHeld.provider)?.release(providerHeld.provider, providerHeld.slotId)
      }
      return
    }
    const pending = this.untracked.get(event.sessionID) ?? 0
    if (pending <= 0) return
    if (pending === 1) this.untracked.delete(event.sessionID)
    else this.untracked.set(event.sessionID, pending - 1)
    this.gate.release(event.sessionID)

    // Id-less launches cannot be attributed to one model, so the model slot they
    // took is freed from whichever model is holding them — exactly one per pending.
    for (const [model, count] of [...this.modelUntracked]) {
      if (count <= 0) continue
      if (count === 1) this.modelUntracked.delete(model)
      else this.modelUntracked.set(model, count - 1)
      this.modelGate?.release(model)
      break
    }
    // Same guess one dimension further out: the provider slot an id-less launch
    // took is freed from whichever provider holds one.
    for (const [provider, count] of [...this.providerUntracked]) {
      if (count <= 0) continue
      if (count === 1) this.providerUntracked.delete(provider)
      else this.providerUntracked.set(provider, count - 1)
      this.providerGates.get(provider)?.release(provider)
      break
    }
  }

  inFlight(sessionID: string): number {
    return this.gate.inFlight(sessionID)
  }

  /**
   * Slots are never cleared wholesale: that would free live ones and let a slow child
   * push its session over the limit.
   */
  prune(): void {
    for (const [callID, held] of [...this.slotByCall]) {
      if (this.gate.inFlight(held.sessionID) === 0) this.slotByCall.delete(callID)
    }
    for (const sessionID of [...this.untracked.keys()]) {
      // A launch whose slot was reaped by lease age has no completion coming, so its
      // pending count would otherwise release someone else's slot later.
      if (this.gate.inFlight(sessionID) === 0) this.untracked.delete(sessionID)
    }
    // Same reasoning on the model dimension, kept in step with the session cleanup.
    for (const [callID, held] of [...this.modelSlotByCall]) {
      if ((this.modelGate?.inFlight(held.model) ?? 0) === 0) this.modelSlotByCall.delete(callID)
    }
    for (const model of [...this.modelUntracked.keys()]) {
      if ((this.modelGate?.inFlight(model) ?? 0) === 0) this.modelUntracked.delete(model)
    }
    // And again on the provider dimension: a third loop, not an incidental one.
    for (const [callID, held] of [...this.providerSlotByCall]) {
      if ((this.providerGates.get(held.provider)?.inFlight(held.provider) ?? 0) === 0) {
        this.providerSlotByCall.delete(callID)
      }
    }
    for (const provider of [...this.providerUntracked.keys()]) {
      if ((this.providerGates.get(provider)?.inFlight(provider) ?? 0) === 0) this.providerUntracked.delete(provider)
    }
  }

  reset(reason?: string): void {
    // The model dimension is cleared here too: a reload that forgot it would inherit
    // slots from the previous process and refuse launches the new one never counted.
    this.slotByCall.clear()
    this.untracked.clear()
    this.modelSlotByCall.clear()
    this.modelUntracked.clear()
    this.providerSlotByCall.clear()
    this.providerUntracked.clear()
    this.gate.reset(reason)
    this.modelGate?.reset(reason)
    for (const gate of this.providerGates.values()) gate.reset(reason)
  }
}
