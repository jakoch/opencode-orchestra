/**
 * The gate must recognise every launch route, not just the host's.
 *
 * This plugin registers its own `orchestra_scout`, `orchestra_advisor` and
 * `orchestra_skeptic` tools. Those names reduce to `scout`, `advisor` and
 * tool name never matched — so the plugin's own delegation path was running
 * completely ungated while the host's native subagent launch was gated. The
 * symptom is invisible: everything works, right up until a session fans out
 * past the limit that was supposedly holding it back.
 */

import { describe, expect, test } from 'bun:test'
import plugin from '../index'
import { FanoutAdmission } from '../src/fanout'
import type { PluginDefinitionLike } from '../src/plugin-types'
import { mixedCatalog } from './fixture'
import type { PluginHarness } from './harness'
import { createPluginHarness } from './harness'

const entry = plugin as PluginDefinitionLike

/** The routes a delegation can arrive by, in the form the host reports them. */
const ROUTES: string[] = ['subagent', 'orchestra_scout', 'orchestra_advisor', 'orchestra_skeptic']

describe('the gate recognises every delegation route', () => {
  test('a namespaced plugin tool is counted, not ignored', async () => {
    const gate = new FanoutAdmission({
      limit: 1,
      acquireTimeoutMs: 20,
      tool: ['subagent', 'scout', 'advisor']
    })
    await gate.admit({ id: 'a', sessionID: 's1', tool: 'orchestra_scout', input: {} })
    // The session now holds its slot, so a second launch must be refused.
    expect(gate.admit({ id: 'b', sessionID: 's1', tool: 'orchestra_scout', input: {} })).rejects.toThrow()
  })

  test('the host route is still gated alongside the plugin routes', async () => {
    const gate = new FanoutAdmission({
      limit: 1,
      acquireTimeoutMs: 20,
      tool: ['subagent', 'scout', 'advisor']
    })
    await gate.admit({ id: 'a', sessionID: 's1', tool: 'subagent', input: {} })
    expect(gate.admit({ id: 'b', sessionID: 's1', tool: 'orchestra_advisor', input: {} })).rejects.toThrow()
  })

  test('a namespaced tool name and its bare form are one gate entry', async () => {
    const gate = new FanoutAdmission({
      limit: 1,
      acquireTimeoutMs: 20,
      tool: ['orchestra_scout']
    })
    await gate.admit({ id: 'a', sessionID: 's1', tool: 'orchestra_scout', input: {} })
    expect(gate.admit({ id: 'b', sessionID: 's1', tool: 'scout', input: {} })).rejects.toThrow()
  })

  test('an unrelated tool is still ignored', async () => {
    const gate = new FanoutAdmission({
      limit: 1,
      acquireTimeoutMs: 20,
      tool: ['subagent', 'scout', 'advisor']
    })
    await gate.admit({ id: 'a', sessionID: 's1', tool: 'bash', input: {} })
    await gate.admit({ id: 'b', sessionID: 's1', tool: 'orchestra_scout', input: {} })
    expect(gate.inFlight('s1')).toBe(1)
  })
})

describe('the plugin gates its own tools', () => {
  test('a fan-out past the limit is refused through orchestra_scout', async () => {
    const harness: PluginHarness = createPluginHarness({
      models: mixedCatalog(),
      options: { maxConcurrentSubagents: 1, fanoutWaitMs: 30 }
    })
    await entry.setup(harness.ctx)
    await harness.settle()

    const call = (text: string) =>
      harness.fireToolBefore({
        tool: 'orchestra_scout',
        input: { text },
        status: 'completed' as const,
        sessionID: 'ses_gate'
      })

    // First launch takes the only slot; the second must be refused rather than
    // waiting out a timeout. This is the assertion the missing tool name broke:
    // with `tool: 'subagent'` the gate ignored both calls and neither threw.
    await call('first')
    await expect(call('second')).rejects.toThrow(/orchestra:|busy/i)
  })

  test('a fan-out past the limit is refused through orchestra_skeptic', async () => {
    // `/panel` deliberately runs two reviewers at once; without `skeptic` in
    // the gate list that concurrency was invisible to admission entirely.
    const harness: PluginHarness = createPluginHarness({
      models: mixedCatalog(),
      options: { maxConcurrentSubagents: 1, fanoutWaitMs: 30 }
    })
    await entry.setup(harness.ctx)
    await harness.settle()

    const call = (text: string) =>
      harness.fireToolBefore({
        tool: 'orchestra_skeptic',
        input: { text },
        status: 'completed' as const,
        sessionID: 'ses_gate'
      })

    await call('first')
    await expect(call('second')).rejects.toThrow(/orchestra:|busy/i)
  })

  test.each(ROUTES)('the gate counts the %s route', async route => {
    const gate = new FanoutAdmission({
      limit: 1,
      acquireTimeoutMs: 20,
      tool: ['subagent', 'scout', 'advisor', 'skeptic']
    })
    await gate.admit({ id: 'a', sessionID: 's1', tool: route, input: {} })
    expect(gate.inFlight('s1')).toBe(1)
  })
})
