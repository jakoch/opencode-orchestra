/**
 * Gate behaviour when a child never reports back.
 *
 * The existing admission tests all follow a call through to a clean release,
 * which is the happy path twice over: the call arrives, and it finishes. A
 * crashed or wedged child does neither, and the slot it took stays taken — so
 * the question these answer is whether a session can wedge itself forever
 * against a limit it no longer has anything running against.
 *
 * Three mechanisms, tested separately because they fail differently: the lease
 * reaps by age, the acquire timeout refuses a waiter rather than hanging it, and
 * `prune` heals the bookkeeping once the lease has done its work.
 *
 * A fake clock throughout: the lease is ten minutes, and a test that waits ten
 * minutes is a test nobody runs.
 */

import { describe, expect, test } from 'bun:test'
import { FanoutAdmission, FanoutGate } from '../src/fanout'

const call = (over: Partial<Parameters<FanoutAdmission['admit']>[0]> = {}) => ({
  id: 'c1',
  sessionID: 's1',
  tool: 'subagent',
  input: { agent: 'scout' },
  ...over
})

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    }
  }
}

describe('a child that never reports back', () => {
  test('the lease reaps an abandoned slot so the session is not wedged', async () => {
    const time = clock()
    const gate = new FanoutGate({ limit: 1, leaseMs: 600_000, now: time.now })

    // The launch takes the only slot and then vanishes: no release, no failure,
    // nothing. This is the exact state a crashed child leaves behind.
    const first = await gate.acquire('s1')
    expect(first.ok).toBe(true)
    expect(gate.inFlight('s1')).toBe(1)

    // A second launch before the lease expires must still be refused: reaping
    // early would let a slow-but-alive child push its session over the limit.
    time.advance(599_999)
    expect(gate.inFlight('s1')).toBe(1)

    // One millisecond later the slot is the gate's to reclaim.
    time.advance(1)
    expect(gate.inFlight('s1')).toBe(0)
    const second = await gate.acquire('s1')
    expect(second.ok).toBe(true)
  })

  test('a queued waiter is admitted when the lease frees a slot', async () => {
    // The reap must reach the waiters, not just the count: otherwise the queue
    // sits until its own timeout even though a slot became free under it.
    const time = clock()
    const gate = new FanoutGate({ limit: 1, leaseMs: 1_000, acquireTimeoutMs: 600_000, now: time.now })
    await gate.acquire('s1')
    expect(gate.queued('s1')).toBe(0)

    const queued = gate.acquire('s1')
    expect(gate.queued('s1')).toBe(1)

    // The abandoned holder ages out. Nothing releases the slot, so the only
    // thing that can unblock this waiter is the lease.
    time.advance(1_001)
    const admission = await queued
    expect(admission.ok).toBe(true)
    expect(gate.queued('s1')).toBe(0)
  })

  test('a waiter is refused on the acquire timeout rather than hanging', async () => {
    // The failure mode this rules out is a hook that never resolves: the plugin
    // would wait on a slot that a live child is entitled to, forever.
    //
    // Real time here, unlike every other test in this file: the timeout is a
    // real `setTimeout` and cannot be moved by the fake clock. 30ms, not 5s —
    // a timeout equal to the harness's own would race it and fail at random.
    const gate = new FanoutGate({ limit: 1, acquireTimeoutMs: 30, leaseMs: 600_000 })
    await gate.acquire('s1')

    const admission = await gate.acquire('s1', 'scout')
    expect(admission.ok).toBe(false)
    expect(admission.refused).toContain('all 1 are busy')
    // The refusal names what was being launched, so the builder can act on it
    // rather than just retrying blindly.
    expect(admission.refused).toContain('scout')
    expect(admission.inFlight).toBe(1)
    // `now` is real here, so this is a genuine duration rather than a fake-clock
    // zero — which is what makes the refusal observably the timeout's doing.
    expect(admission.waitedMs).toBeGreaterThan(0)
  })

  test('a timed-out waiter leaves the queue clean', async () => {
    // A waiter that timed out but stayed queued would occupy a place in the line
    // that no release will ever reach, and the queue would drift upward forever.
    const gate = new FanoutGate({ limit: 1, acquireTimeoutMs: 5, leaseMs: 600_000 })
    await gate.acquire('s1')
    const admission = await gate.acquire('s1')
    expect(admission.ok).toBe(false)
    expect(gate.queued('s1')).toBe(0)
    gate.release('s1')
    expect(gate.inFlight('s1')).toBe(0)
  })

  test('an abandoned slot is not released twice by a late completion', async () => {
    // The sequence that loses a slot: a child is slow past the lease, the gate
    // reaps and re-admits, then the slow child finally reports back and its
    // release frees the *new* child's slot. Two launches in flight on one slot.
    const time = clock()
    const gate = new FanoutGate({ limit: 1, leaseMs: 1_000, now: time.now })
    const slow = await gate.acquire('s1')

    time.advance(1_001)
    const fresh = await gate.acquire('s1')
    expect(fresh.ok).toBe(true)

    // The straggler finally reports. It is releasing a slot id the gate has
    // already forgotten about.
    gate.release('s1', slow.ok ? slow.slotId : undefined)
    expect(gate.inFlight('s1')).toBe(1)
  })
})

describe('the same, across all three dimensions', () => {
  test('an abandoned launch leaves all three dimensions occupied', async () => {
    const time = clock()
    const gate = new FanoutAdmission({
      limit: 1,
      modelLimit: 1,
      providerConcurrency: { ollama: 1 },
      leaseMs: 600_000,
      now: time.now
    })

    // Admitted on session, model and provider, then the child dies. Nothing
    // calls release on any of the three.
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'ollama/deep' }))
    expect(gate.inFlight('s1')).toBe(1)
    expect(gate.modelInFlight('ollama/deep')).toBe(1)
    expect(gate.providerInFlight('ollama')).toBe(1)
  })

  test('lease age frees all three dimensions together', async () => {
    // One lease for all three, so they age out in step. A dimension that lagged
    // would refuse the retry this session is entitled to, and the builder would
    // be told to narrow a request that had simply had a child crash.
    const time = clock()
    const gate = new FanoutAdmission({
      limit: 1,
      modelLimit: 1,
      providerConcurrency: { ollama: 1 },
      leaseMs: 600_000,
      now: time.now
    })
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'ollama/deep' }))

    time.advance(600_001)
    expect(gate.inFlight('s1')).toBe(0)
    expect(gate.modelInFlight('ollama/deep')).toBe(0)
    expect(gate.providerInFlight('ollama')).toBe(0)

    // And the retry actually goes through, rather than being refused on whichever
    // dimension happened to lag.
    await gate.admit(call({ id: 'b', sessionID: 's1', model: 'ollama/deep' }))
    expect(gate.inFlight('s1')).toBe(1)
  })

  test('a straggler completion does not free a slot a reaped launch handed on', async () => {
    // The cross-dimension version of the double-release above. After a reap the
    // bookkeeping still names the dead call, so prune has to drop it or its
    // release will take out the slot its successor holds.
    const time = clock()
    const gate = new FanoutAdmission({
      limit: 1,
      modelLimit: 1,
      providerConcurrency: { ollama: 1 },
      leaseMs: 600_000,
      now: time.now
    })
    const launch = call({ id: 'a', sessionID: 's1', model: 'ollama/deep' })
    await gate.admit(launch)

    time.advance(600_001)
    await gate.admit(call({ id: 'b', sessionID: 's1', model: 'ollama/deep' }))
    gate.prune()

    // The dead call finally reports back. Nothing it holds is live now.
    gate.release(launch)
    expect(gate.inFlight('s1')).toBe(1)
    expect(gate.modelInFlight('ollama/deep')).toBe(1)
    expect(gate.providerInFlight('ollama')).toBe(1)
  })

  test('a refusal mid-chain does not strand the dimensions already held', async () => {
    // The unwind, under a gate that is actually full: the model gate refuses,
    // and the session slot taken while queueing for it must go back.
    const gate = new FanoutAdmission({
      limit: 8,
      modelLimit: 1,
      acquireTimeoutMs: 5,
      leaseMs: 600_000
    })
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'ollama/deep' }))

    // Different session, same model: it gets the session slot, is refused on the
    // model, and must give the session slot back on the way out.
    await expect(
      gate.admit(call({ id: 'b', sessionID: 's2', model: 'ollama/deep' }))
    ).rejects.toThrow(/per model|busy/)

    // s2 was never wedged; if the unwind had missed, this second attempt would
    // have run into a full session gate rather than the same model refusal.
    expect(gate.inFlight('s2')).toBe(0)
  })
})
