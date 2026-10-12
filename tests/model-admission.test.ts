/**
 * Per-model admission, alongside the per-session cap.
 *
 * The two answer different questions. `limit` bounds what one caller can ask
 * for; `modelLimit` bounds what one backend absorbs. Two sessions each within
 * their own limit can still collide on the same model, which is the case this
 * exists for — roles can share a model and the resolver reports that as
 * `sharedWith`.
 *
 * The failure worth guarding is a leak: a launch that takes a model slot and
 * gives back only the session one would starve the model cap over time and
 * eventually refuse everything, long after the real concurrency is gone.
 */

import { describe, expect, test } from 'bun:test'
import { FanoutAdmission } from '../src/fanout'

const call = (over: Partial<Parameters<FanoutAdmission['admit']>[0]> = {}) => ({
  id: 'c1',
  sessionID: 's1',
  tool: 'subagent',
  input: { agent: 'scout' },
  ...over
})

describe('per-model admission', () => {
  test('is off unless a limit is set', async () => {
    // One session, so the session limit alone would queue the third launch and
    // the test would prove nothing about the model cap. Raising it keeps the
    // only variable in play the model dimension.
    const gate = new FanoutAdmission({ limit: 8 })
    for (const id of ['a', 'b', 'c', 'd']) {
      await gate.admit(call({ id, model: 'opencode/shared' }))
    }
    expect(gate.modelInFlight('opencode/shared')).toBe(0)
  })

  test('refuses a second launch on one model from a different session', async () => {
    // Each session is within its own limit; only the model cap catches this.
    const gate = new FanoutAdmission({
      limit: 4,
      modelLimit: 1,
      acquireTimeoutMs: 20
    })
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'opencode/shared' }))
    expect(gate.admit(call({ id: 'b', sessionID: 's2', model: 'opencode/shared' }))).rejects.toThrow(
      /concurrency|busy/i
    )
  })

  test('allows two launches on two different models', async () => {
    const gate = new FanoutAdmission({ limit: 4, modelLimit: 1, acquireTimeoutMs: 20 })
    await gate.admit(call({ id: 'a', model: 'opencode/one' }))
    await expect(gate.admit(call({ id: 'b', model: 'opencode/two' }))).resolves.toBeUndefined()
  })

  test('a refusal does not consume the session slot', async () => {
    // The session slot is taken before the model slot, so a model refusal must
    // hand it back — or the session is capped by calls that never ran.
    const gate = new FanoutAdmission({
      limit: 1,
      modelLimit: 1,
      acquireTimeoutMs: 20
    })
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'opencode/shared' }))
    await expect(gate.admit(call({ id: 'b', sessionID: 's2', model: 'opencode/shared' }))).rejects.toThrow()

    expect(gate.inFlight('s2')).toBe(0)
  })

  test('a completion frees both dimensions', async () => {
    // The leak this file exists to prevent.
    const gate = new FanoutAdmission({ limit: 4, modelLimit: 1, acquireTimeoutMs: 20 })
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'opencode/shared' }))
    gate.release(call({ id: 'a', sessionID: 's1', model: 'opencode/shared' }))

    expect(gate.modelInFlight('opencode/shared')).toBe(0)
    expect(gate.inFlight('s1')).toBe(0)
  })

  test('repeated completions do not leak model slots', async () => {
    const gate = new FanoutAdmission({ limit: 4, modelLimit: 2, acquireTimeoutMs: 20 })
    for (const id of ['a', 'b']) {
      await gate.admit(call({ id, sessionID: 's1', model: 'opencode/shared' }))
      gate.release(call({ id, sessionID: 's1', model: 'opencode/shared' }))
    }
    expect(gate.modelInFlight('opencode/shared')).toBe(0)
  })

  test('an id-less launch still frees exactly one model slot', async () => {
    const gate = new FanoutAdmission({ limit: 4, modelLimit: 2, acquireTimeoutMs: 20 })
    await gate.admit(call({ id: undefined, sessionID: 's1', model: 'opencode/shared' }))
    await gate.admit(call({ id: undefined, sessionID: 's1', model: 'opencode/other' }))
    expect(gate.modelInFlight('opencode/shared')).toBe(1)

    gate.release(call({ id: undefined, sessionID: 's1', model: 'opencode/shared' }))
    expect(gate.modelInFlight('opencode/shared')).toBe(0)
  })

  test('an unrelated tool call frees nothing', async () => {
    const gate = new FanoutAdmission({ limit: 4, modelLimit: 1, acquireTimeoutMs: 20 })
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'opencode/shared' }))
    gate.release(call({ id: 'b', sessionID: 's1', tool: 'bash', model: 'opencode/shared' }))
    expect(gate.modelInFlight('opencode/shared')).toBe(1)
  })

  test('a call with no known model falls back to the session limit', async () => {
    // Refusing here would be worse than useless: the model cap exists to shed
    // load on a backend, and with no model there is no backend to shed.
    const gate = new FanoutAdmission({ limit: 1, modelLimit: 1, acquireTimeoutMs: 20 })
    await gate.admit(call({ id: 'a', sessionID: 's1' }))
    await expect(gate.admit(call({ id: 'b', sessionID: 's2' }))).resolves.toBeUndefined()
  })

  test('reset clears model slots too', async () => {
    const gate = new FanoutAdmission({ limit: 4, modelLimit: 2, acquireTimeoutMs: 20 })
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'opencode/shared' }))
    gate.reset('test')
    expect(gate.modelInFlight('opencode/shared')).toBe(0)
  })
})
