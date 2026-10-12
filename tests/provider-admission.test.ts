/**
 * Per-provider admission, alongside the per-session and per-model caps.
 *
 * The third dimension answers one more question: how many children may run on
 * one provider runtime at once. On a local backend that is one accelerator
 * with one KV pool, so N children spread over sessions and models still
 * thrash it — which neither of the first two caps can see.
 *
 * The failure worth guarding, three times over: a launch refused on one
 * dimension must unwind the slots it already holds on the others, an id-less
 * launch must free exactly one slot per dimension, and `prune`/`reset` must
 * cover the third dimension or slots leak silently.
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

describe('per-provider admission', () => {
  test('is off unless a provider is configured', async () => {
    // Wide session and model caps, so only a provider cap could refuse.
    const gate = new FanoutAdmission({ limit: 8, modelLimit: 8 })
    for (const id of ['a', 'b', 'c']) {
      await gate.admit(call({ id, sessionID: `s${id}`, model: 'ollama/deep' }))
    }
    expect(gate.providerInFlight('ollama')).toBe(0)
  })

  test('refuses a second launch on one provider across sessions and models', async () => {
    const gate = new FanoutAdmission({
      limit: 8,
      modelLimit: 8,
      providerConcurrency: { ollama: 1 },
      acquireTimeoutMs: 20
    })
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'ollama/deep' }))
    await expect(gate.admit(call({ id: 'b', sessionID: 's2', model: 'ollama/other' }))).rejects.toThrow(/per provider/)
  })

  test('an unconfigured provider is unbounded', async () => {
    const gate = new FanoutAdmission({ limit: 8, providerConcurrency: { ollama: 1 } })
    for (const id of ['a', 'b', 'c']) {
      await gate.admit(call({ id, sessionID: `s${id}`, model: 'remote/other' }))
    }
    // All three admitted — and no gate was even built for the provider.
    expect(gate.providerInFlight('remote')).toBe(0)
  })

  test('a provider refusal unwinds the session and model slots it held', async () => {
    const gate = new FanoutAdmission({
      limit: 8,
      modelLimit: 8,
      providerConcurrency: { ollama: 1 },
      acquireTimeoutMs: 20
    })
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'ollama/deep' }))
    await expect(gate.admit(call({ id: 'b', sessionID: 's2', model: 'ollama/deep' }))).rejects.toThrow()
    // Nothing wedged anywhere: the refused call gave back all three slots.
    expect(gate.inFlight('s2')).toBe(0)
    expect(gate.modelInFlight('ollama/deep')).toBe(1)
    expect(gate.providerInFlight('ollama')).toBe(1)
    gate.release(call({ id: 'a', sessionID: 's1', model: 'ollama/deep' }))
    expect(gate.modelInFlight('ollama/deep')).toBe(0)
    expect(gate.providerInFlight('ollama')).toBe(0)
  })

  test('an id-less launch frees exactly one slot per dimension', async () => {
    const gate = new FanoutAdmission({
      limit: 8,
      modelLimit: 8,
      providerConcurrency: { ollama: 2 }
    })
    const launch = { sessionID: 's1', tool: 'subagent', input: {}, model: 'ollama/deep' }
    await gate.admit(launch)
    await gate.admit(launch)
    expect(gate.providerInFlight('ollama')).toBe(2)
    gate.release(launch)
    expect(gate.inFlight('s1')).toBe(1)
    expect(gate.modelInFlight('ollama/deep')).toBe(1)
    expect(gate.providerInFlight('ollama')).toBe(1)
    gate.release(launch)
    expect(gate.inFlight('s1')).toBe(0)
    expect(gate.modelInFlight('ollama/deep')).toBe(0)
    expect(gate.providerInFlight('ollama')).toBe(0)
  })

  test('reset clears the provider dimension', async () => {
    const gate = new FanoutAdmission({
      limit: 1,
      modelLimit: 1,
      providerConcurrency: { ollama: 1 },
      acquireTimeoutMs: 20
    })
    const launch = { sessionID: 's1', tool: 'subagent', input: {}, model: 'ollama/deep' }
    await gate.admit({ ...launch, id: 'a' })
    gate.reset('the plugin unloaded')
    // A stray completion for a pre-reset launch must be a no-op on every
    // dimension, not a free of whatever the next launch holds. (Releases are
    // idempotent and prune heals stale bookkeeping, so the map-clearing above
    // is defense-in-depth rather than load-bearing; this test locks the
    // observable contract, not the clearing itself.)
    gate.release({ ...launch, id: 'a' })
    expect(gate.inFlight('s1')).toBe(0)
    expect(gate.modelInFlight('ollama/deep')).toBe(0)
    expect(gate.providerInFlight('ollama')).toBe(0)
    // A reload that forgot the provider maps would refuse this: the old slots
    // would still be counted against the new process.
    await gate.admit({ ...launch, id: 'b' })
    expect(gate.providerInFlight('ollama')).toBe(1)
  })

  test('prune keeps the provider bookkeeping in step', async () => {
    const gate = new FanoutAdmission({
      limit: 8,
      modelLimit: 8,
      providerConcurrency: { ollama: 1 },
      acquireTimeoutMs: 20
    })
    await gate.admit(call({ id: 'a', sessionID: 's1', model: 'ollama/deep' }))
    gate.release(call({ id: 'a', sessionID: 's1', model: 'ollama/deep' }))
    gate.prune()
    // Released and pruned: a fresh launch must find every dimension empty.
    await gate.admit(call({ id: 'b', sessionID: 's1', model: 'ollama/deep' }))
    expect(gate.inFlight('s1')).toBe(1)
    expect(gate.providerInFlight('ollama')).toBe(1)
  })

  test('a launch without a model skips provider gating', async () => {
    const gate = new FanoutAdmission({ limit: 8, providerConcurrency: { ollama: 1 } })
    await gate.admit({ id: 'a', sessionID: 's1', tool: 'subagent', input: { agent: 'scout' } })
    expect(gate.providerInFlight('ollama')).toBe(0)
  })
})
