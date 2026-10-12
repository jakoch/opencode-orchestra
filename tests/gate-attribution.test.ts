/**
 * Can this install produce the gate counters a cut decision needs?
 *
 * the gate decision is blocked on per-dimension refusals, and the standing objection was
 * that this credential refuses every programmatic delegation — so dispatch
 * never succeeds and the counters stay empty. That objection is about
 * `dispatch`, and it is correct: `recordDispatch` never fires.
 *
 * It does not hold for the gates. The gate is consulted in the
 * `execute.before` hook, which runs *before* the plugin opens a session. A
 * refusal upstream of admission is therefore still countable, and the dimension
 * rides on the thrown error rather than being recovered from the message.
 *
 * That is worth asserting rather than reasoning about, because the two readings
 * differ in what they license: one says this needs a working credential, the
 * other says a window recorded here is *partial* — gate refusals are valid,
 * dispatch counts are not.
 */

import { describe, expect, test } from 'bun:test'
import { FanoutAdmission } from '../src/fanout'
import { DELEGATION_TOOLS } from '../src/loop-guard'
import type { GateDimension } from '../src/telemetry'

const call = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  sessionID: 's1',
  tool: 'orchestra_scout',
  input: { agent: 'scout' },
  model: 'opencode/nemotron-3-ultra-free',
  ...over
})

/** The plugin's real construction: the shared tool list is what makes it count. */
const gate = (over: Record<string, unknown> = {}) =>
  new FanoutAdmission({ limit: 1, acquireTimeoutMs: 30, tool: DELEGATION_TOOLS, ...over })

describe('gate refusals are countable without a working credential', () => {
  test('a second concurrent launch is refused, and names its dimension', async () => {
    // No delegation ever runs here, so nothing succeeds — and the refusal is
    // still raised, attributed, and ready to count.
    const admission = gate()
    await admission.admit(call('a'))
    await expect(admission.admit(call('b'))).rejects.toThrow()

    // Recovered the way `plugin/index.ts` does it: from the error, not the prose.
    const error = await admission.admit(call('c')).catch((e: unknown) => e)
    const dimension = (error as Partial<{ fanoutDimension: GateDimension }>).fanoutDimension
    expect(dimension).toBe('session')
  })

  test("the plugin's own tools are gated, not just the host's", async () => {
    // `orchestra_scout` reduces to `scout`. Without the shared `DELEGATION_TOOLS`
    // list the gate defaults to `['subagent']` and every launch this plugin
    // makes is invisible to it — which would make the counters read zero
    // while delegation was in fact happening.
    const withoutList = new FanoutAdmission({ limit: 1, acquireTimeoutMs: 30 })
    await withoutList.admit(call('a'))
    expect(withoutList.inFlight('s1')).toBe(0)

    const withList = gate()
    await withList.admit(call('a'))
    expect(withList.inFlight('s1')).toBe(1)
  })

  test('each dimension is attributed separately', async () => {
    // The open gate decisions are per-dimension, so a counter that
    // recorded one bucket for all three could not decide any of them.
    const session = gate({ modelLimit: 8, providerConcurrency: {} })
    await session.admit(call('a', { sessionID: 's1' }))
    const onSession = await session.admit(call('b', { sessionID: 's1' })).catch((e: unknown) => e)
    expect((onSession as { fanoutDimension?: string }).fanoutDimension).toBe('session')

    const model = gate({ limit: 8, modelLimit: 1 })
    await model.admit(call('a', { sessionID: 's1' }))
    const onModel = await model.admit(call('b', { sessionID: 's2' })).catch((e: unknown) => e)
    expect((onModel as { fanoutDimension?: string }).fanoutDimension).toBe('model')

    const provider = gate({ limit: 8, modelLimit: 8, providerConcurrency: { opencode: 1 } })
    await provider.admit(call('a', { sessionID: 's1' }))
    const onProvider = await provider.admit(call('b', { sessionID: 's2' })).catch((e: unknown) => e)
    expect((onProvider as { fanoutDimension?: string }).fanoutDimension).toBe('provider')
  })

  test('the provider gate refuses nothing when unconfigured', async () => {
    // The reason it could be cut at all: off by default, and with nothing
    // configured there is no dimension to refuse on.
    const admission = gate({ limit: 1 })
    await admission.admit(call('a'))
    await admission.admit(call('b', { sessionID: 's2' }))
    // Both held only the session slot; no provider was configured to cap.
    expect(admission.providerInFlight('opencode')).toBe(0)
  })
})
