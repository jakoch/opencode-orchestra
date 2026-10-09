/**
 * Subagent fan-out admission.
 *
 * The builder is told to delegate searching to the scout, and a model will
 * happily launch six of them in one message. Each launch is a provider request,
 * so on a capped tier that is how a session turns a rate limit into a failure.
 * Permissions cannot express this — the `subagent` action gates *which* agent, not
 * how many at once — so the limit is enforced where launches actually happen: the
 * tool hook, before the call is dispatched.
 *
 * Excess launches wait rather than fail, because a model that asked for four
 * searches and got an error will usually give up on three of them. A bounded wait
 * turns a stampede into a queue; only a launch that cannot get a slot in time is
 * refused, and it is refused with a message the model can act on.
 *
 * Slots are released when the tool completes, and reaped by lease age if a call
 * never reports back, so a crashed child cannot wedge a session shut.
 */

export interface FanoutOptions {
  /** Maximum concurrent subagent launches per session. */
  limit?: number
  /** How long a launch waits for a slot before it is refused. */
  acquireTimeoutMs?: number
  /** Reap a slot this long after it was taken, in case the call never reports. */
  leaseMs?: number
  /** Injected for tests. */
  now?: () => number
}

export interface Admission {
  ok: boolean
  /** Identifies the slot taken, for an exact release later. */
  slotId?: string
  /** Time spent waiting for a slot. */
  waitedMs: number
  /** Present when refused: why, in terms the model can act on. */
  refused?: string
  /** Number of launches already in flight when this one was admitted. */
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
  private readonly limit: number
  private readonly acquireTimeoutMs: number
  private readonly leaseMs: number
  private readonly now: () => number

  constructor(options: FanoutOptions = {}) {
    this.limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT))
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.now = options.now ?? Date.now
  }

  /** Drops slots whose call never reported back, so they cannot leak. */
  private reap(key: string): Slot[] {
    const held = this.slots.get(key) ?? []
    if (!held.length) return held
    const cutoff = this.now() - this.leaseMs
    const live = held.filter((slot) => slot.takenAt >= cutoff)
    if (live.length !== held.length) this.slots.set(key, live)
    return live
  }

  private wake(key: string): void {
    const queue = this.waiters.get(key)
    if (!queue?.length) return
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
        inFlight: held.length,
      })
    }
    this.slots.set(key, held)
    if (!queue.length) this.waiters.delete(key)
  }

  /**
   * Waits for a slot. Resolves with `ok: false` rather than throwing, so the
   * caller decides how to surface a refusal to the model.
   */
  acquire(key: string, label?: string): Promise<Admission> {
    const startedAt = this.now()
    const held = this.reap(key)
    if (held.length < this.limit) {
      const slot: Slot = { id: `slot-${startedAt}-${held.length}`, takenAt: startedAt }
      held.push(slot)
      this.slots.set(key, held)
      return Promise.resolve({ ok: true, slotId: slot.id, waitedMs: 0, inFlight: held.length })
    }

    return new Promise<Admission>((resolve) => {
      const queue = this.waiters.get(key) ?? []
      const waiter: Waiter = { resolve, startedAt }
      waiter.timer = setTimeout(() => {
        const current = this.waiters.get(key) ?? []
        const index = current.indexOf(waiter)
        if (index >= 0) current.splice(index, 1)
        if (!current.length) this.waiters.delete(key)
        resolve({
          ok: false,
          waitedMs: this.now() - startedAt,
          refused:
            `The orchestra allows ${this.limit} concurrent subagent call(s) per session and all ` +
            `${this.limit} are busy${label ? ` (launching "${label}")` : ""}. ` +
            `Work on the results you already have, then launch the next one — or narrow the request so one call answers it.`,
          inFlight: this.reap(key).length,
        })
      }, this.acquireTimeoutMs)
      queue.push(waiter)
      this.waiters.set(key, queue)
    })
  }

  /** Frees a slot. Unknown ids are ignored, so a double release is harmless. */
  release(key: string, slotId?: string): void {
    const held = this.reap(key)
    if (!held.length) return
    if (slotId) {
      const index = held.findIndex((slot) => slot.id === slotId)
      if (index >= 0) held.splice(index, 1)
    } else {
      held.pop()
    }
    this.slots.set(key, held)
    this.wake(key)
  }

  /** Current occupancy, after reaping stale slots. */
  inFlight(key: string): number {
    return this.reap(key).length
  }

  /** Launches waiting for a slot in this session. */
  queued(key: string): number {
    return this.waiters.get(key)?.length ?? 0
  }

  /**
   * Drops all state. Pending waiters are refused rather than left hanging, so a
   * plugin unload cannot strand an awaited hook forever.
   */
  reset(reason = "the plugin unloaded"): void {
    for (const [key, queue] of this.waiters) {
      for (const waiter of queue) {
        if (waiter.timer) clearTimeout(waiter.timer)
        waiter.resolve({
          ok: false,
          waitedMs: this.now() - waiter.startedAt,
          refused: `Waiting for a subagent slot ended because ${reason}.`,
          inFlight: 0,
        })
      }
    }
    this.waiters.clear()
    this.slots.clear()
  }
}

/** Default limits, exported so the report can state them. */
export const FANOUT_DEFAULTS = {
  limit: DEFAULT_LIMIT,
  acquireTimeoutMs: DEFAULT_ACQUIRE_TIMEOUT_MS,
  leaseMs: DEFAULT_LEASE_MS,
}