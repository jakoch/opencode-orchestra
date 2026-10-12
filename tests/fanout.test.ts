/**
 * Fan-out admission and slot correlation.
 * The gate itself is covered by the self-test fixtures; what is tested here is
 * the layer above it — deciding which slot a completion frees. The regression
 * that matters: the host does not promise a tool-call id on every tool event, and
 * a launch without one used to take a slot that nothing could ever return, so
 * two of them wedged a session at its limit for the full ten-minute lease.
 */

import { describe, expect, test } from 'bun:test'
import type { FanoutCall } from '../src/fanout'
import { FanoutAdmission } from '../src/fanout'

/** Short enough that a slot which is never released fails fast instead of hanging. */
const FAST_REFUSAL = { acquireTimeoutMs: 50 }

function subagent(sessionID: string, extra: Partial<FanoutCall> = {}): FanoutCall {
  return { sessionID, tool: 'subagent', input: { agent: 'scout' }, ...extra }
}

describe('fan-out: launches the host reports without an id', () => {
  test('two id-less launches hand their slots back', async () => {
    const fanout = new FanoutAdmission({ limit: 2, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1'))
    expect(fanout.inFlight('s1')).toBe(1)
    fanout.release(subagent('s1'))
    expect(fanout.inFlight('s1')).toBe(0)

    await fanout.admit(subagent('s1'))
    fanout.release(subagent('s1'))
    expect(fanout.inFlight('s1')).toBe(0)
  })

  test('a third launch is admitted, not refused, after two id-less ones', async () => {
    // The reported repro: two id-less calls used to leave the
    // session at its limit, so the third waited out the 120s acquire timeout and
    // was refused — and the slot only came back after the 10-minute lease.
    const fanout = new FanoutAdmission({ limit: 2, ...FAST_REFUSAL })
    for (const _ of [0, 1]) {
      await fanout.admit(subagent('s1'))
      fanout.release(subagent('s1'))
    }
    await expect(fanout.admit(subagent('s1'))).resolves.toBeUndefined()
    expect(fanout.inFlight('s1')).toBe(1)
  })

  test('a slot is still taken while the launch is running', async () => {
    // The fallback must not turn the gate off: the limit is only released by the
    // completion, exactly as it is when the host does send an id.
    const fanout = new FanoutAdmission({ limit: 2, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1'))
    await fanout.admit(subagent('s1'))
    expect(fanout.inFlight('s1')).toBe(2)
    await expect(fanout.admit(subagent('s1'))).rejects.toThrow(/orchestra:/)
  })

  test('only completions of the gated tool may free an id-less slot', async () => {
    // Every tool in the session fires the after hook. If a bash call released a
    // slot, the gate would be a no-op that added latency.
    const fanout = new FanoutAdmission({ limit: 2, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1'))
    fanout.release({ sessionID: 's1', tool: 'bash', input: { command: 'ls' } })
    expect(fanout.inFlight('s1')).toBe(1)
    fanout.release(subagent('s1'))
    expect(fanout.inFlight('s1')).toBe(0)
  })

  test('namespaced tool names are still the gated tool', async () => {
    const fanout = new FanoutAdmission({ limit: 1, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1', { tool: 'session_subagent' }))
    fanout.release(subagent('s1', { tool: 'session_subagent' }))
    expect(fanout.inFlight('s1')).toBe(0)
  })
})

describe('fan-out: launches the host reports with an id', () => {
  test('behaviour is unchanged: each id frees exactly its own slot', async () => {
    const fanout = new FanoutAdmission({ limit: 2, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1', { id: 'call-1' }))
    await fanout.admit(subagent('s1', { id: 'call-2' }))
    expect(fanout.inFlight('s1')).toBe(2)

    fanout.release(subagent('s1', { id: 'call-1' }))
    expect(fanout.inFlight('s1')).toBe(1)
    fanout.release(subagent('s1', { id: 'call-2' }))
    expect(fanout.inFlight('s1')).toBe(0)
  })

  test('a double completion cannot free a second slot', async () => {
    const fanout = new FanoutAdmission({ limit: 2, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1', { id: 'call-1' }))
    await fanout.admit(subagent('s1', { id: 'call-2' }))
    fanout.release(subagent('s1', { id: 'call-1' }))
    fanout.release(subagent('s1', { id: 'call-1' }))
    expect(fanout.inFlight('s1')).toBe(1)
  })

  test('an id that was never admitted frees nothing', async () => {
    const fanout = new FanoutAdmission({ limit: 2, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1', { id: 'call-1' }))
    fanout.release(subagent('s1', { id: 'call-from-another-session' }))
    expect(fanout.inFlight('s1')).toBe(1)
  })

  test('ids and id-less launches share one budget in a session', async () => {
    const fanout = new FanoutAdmission({ limit: 2, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1', { id: 'call-1' }))
    await fanout.admit(subagent('s1'))
    expect(fanout.inFlight('s1')).toBe(2)
    fanout.release(subagent('s1'))
    expect(fanout.inFlight('s1')).toBe(1)
    fanout.release(subagent('s1', { id: 'call-1' }))
    expect(fanout.inFlight('s1')).toBe(0)
  })
})

describe('fan-out: sessions and the off switch', () => {
  test('gates stay per session', async () => {
    const fanout = new FanoutAdmission({ limit: 1, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1'))
    await fanout.admit(subagent('s2'))
    expect(fanout.inFlight('s1')).toBe(1)
    expect(fanout.inFlight('s2')).toBe(1)
  })

  test('a refused launch names what was launched and what to do', async () => {
    const fanout = new FanoutAdmission({ limit: 1, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1'))
    await expect(fanout.admit(subagent('s1'))).rejects.toThrow(/scout/)
    await expect(fanout.admit(subagent('s1'))).rejects.toThrow(/narrow the request|Work on the results/)
  })

  test('a limit of 0 disables the gate instead of clamping it to one', async () => {
    // `FanoutGate` clamps a zero limit up, because it always has a caller; the
    // plugin's off switch has none, so it must not take a slot at all.
    const fanout = new FanoutAdmission({ limit: 0 })
    for (const _ of [0, 1, 2]) await fanout.admit(subagent('s1'))
    expect(fanout.inFlight('s1')).toBe(0)
  })

  test('tools other than the gated one never take a slot', async () => {
    const fanout = new FanoutAdmission({ limit: 1, ...FAST_REFUSAL })
    await fanout.admit({ sessionID: 's1', tool: 'bash', input: { command: 'ls' } })
    expect(fanout.inFlight('s1')).toBe(0)
    // The budget is still there for the launch that matters.
    await fanout.admit(subagent('s1'))
    expect(fanout.inFlight('s1')).toBe(1)
  })
})

describe('fan-out: housekeeping', () => {
  test('pruning forgets bookkeeping for sessions with nothing in flight', async () => {
    const fanout = new FanoutAdmission({ limit: 2, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1', { id: 'call-1' }))
    fanout.release(subagent('s1', { id: 'call-1' }))
    // Nothing is held, so the entry is dead weight and a later completion must not
    // reach for a slot that a new launch is holding.
    fanout.prune()
    fanout.release(subagent('s1', { id: 'call-1' }))
    await fanout.admit(subagent('s1', { id: 'call-2' }))
    fanout.release(subagent('s1', { id: 'call-2' }))
    expect(fanout.inFlight('s1')).toBe(0)
  })

  test('pruning leaves a session with a launch in flight untouched', async () => {
    const fanout = new FanoutAdmission({ limit: 2, ...FAST_REFUSAL })
    await fanout.admit(subagent('s1', { id: 'call-1' }))
    fanout.prune()
    expect(fanout.inFlight('s1')).toBe(1)
    fanout.release(subagent('s1', { id: 'call-1' }))
    expect(fanout.inFlight('s1')).toBe(0)
  })

  test('reset drops held slots and refuses what is queued', async () => {
    const fanout = new FanoutAdmission({ limit: 1, acquireTimeoutMs: 60_000 })
    await fanout.admit(subagent('s1'))
    const queued = fanout.admit(subagent('s1'))
    fanout.reset('the plugin unloaded')
    await expect(queued).rejects.toThrow(/the plugin unloaded/)
    expect(fanout.inFlight('s1')).toBe(0)
    // A reset also drops the id-less bookkeeping, so the next launch starts clean.
    await fanout.admit(subagent('s1'))
    expect(fanout.inFlight('s1')).toBe(1)
  })
})
