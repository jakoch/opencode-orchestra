/**
 * The session-backed delegation tools, end to end through the real plugin.
 *
 * `src/delegate.ts` is tested on its own; what cannot be reached there is
 * whether the plugin registers the tools at all, and whether the builder can
 * actually call one and get an answer back. A delegation module that is never
 * registered is indistinguishable, from outside, from no delegation.
 */

import { describe, expect, test } from 'bun:test'
import plugin from '../index'
import type { PluginDefinitionLike } from '../src/plugin-types'
import { model } from './fixture'
import type { PluginHarness } from './harness'
import { createPluginHarness } from './harness'

const entry = plugin as PluginDefinitionLike

const MODELS = [model('flash-free', 0, 0, { name: 'flash' }), model('deep-free', 0, 0, { name: 'deep' })]

async function loaded(pluginOptions: Record<string, unknown> = {}): Promise<PluginHarness> {
  const harness = createPluginHarness({ models: MODELS, options: pluginOptions })
  await entry.setup(harness.ctx)
  await harness.settle()
  return harness
}

/**
 * A harness whose failure store already holds every model — the state a session
 * reaches once the host has refused the whole catalog.
 *
 * `blocked`, not merely `rejected`, because that is what empties the resolver's
 * candidate set: a rejection deliberately stays visible to detection, while a
 * block removes the model from it. The empty-candidate branch is where the pin
 * rescue lives, so a test seeded with rejections alone would never reach it.
 *
 * Seeded between construction and `setup` because that is when the store is
 * read, and a failure recorded after it would not change the assignment this
 * test is about.
 */
async function loadedWithQuarantine(pluginOptions: Record<string, unknown> = {}): Promise<PluginHarness> {
  const harness = createPluginHarness({ models: MODELS, options: pluginOptions })
  const now = Date.now()
  harness.store.set(
    'quarantine',
    Object.fromEntries(
      MODELS.map(entry => {
        const ref = `${entry.providerID}/${entry.id}`
        return [
          ref,
          {
            ref,
            reason: "OpenCode's free tier can only be used from within OpenCode",
            kind: 'rejected',
            blocked: true,
            occurrences: 1,
            firstSeen: now,
            lastSeen: now
          }
        ]
      })
    )
  )
  await entry.setup(harness.ctx)
  await harness.settle()
  return harness
}

/** Calls a registered tool the way the host would. */
async function callTool(harness: PluginHarness, name: string, input: unknown) {
  const tool = harness.registeredTools.get(name)
  if (!tool) throw new Error(`tool ${name} was not registered`)
  return (tool.execute as (input: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(input)
}

describe('session-backed delegation tools', () => {
  test('registers one tool per delegated role', async () => {
    const harness = await loaded()
    expect(harness.registeredTools.has('orchestra_scout')).toBe(true)
    expect(harness.registeredTools.has('orchestra_advisor')).toBe(true)
  })

  test('does not register a delegation tool for builder', async () => {
    // Builder is the primary agent; delegating to itself would be a loop.
    const harness = await loaded()
    expect(harness.registeredTools.has('builder')).toBe(false)
  })

  test('a delegated call runs the named agent and returns its reply', async () => {
    const harness = await loaded()
    harness.sessionReplies['where is X?'] = 'src/a.ts:12'

    const result = await callTool(harness, 'orchestra_scout', { text: 'where is X?' })

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('src/a.ts:12')
    expect(harness.sessionAgent).toBe('scout')
  })

  test('advisor delegates as the advisor', async () => {
    const harness = await loaded()
    harness.sessionReplies['review'] = 'VERDICT: approve'
    await callTool(harness, 'orchestra_advisor', { text: 'review' })
    expect(harness.sessionAgent).toBe('advisor')
  })

  test('the delegated session is torn down', async () => {
    const harness = await loaded()
    harness.sessionReplies['q'] = 'a'
    await callTool(harness, 'orchestra_scout', { text: 'q' })
    expect(harness.removedSessions.length).toBeGreaterThan(0)
  })

  test('a refused delegation reports the error rather than an answer', async () => {
    const harness = await loaded()
    harness.agentFailures['scout'] = 'OpenCode’s free tier can only be used from within OpenCode'

    const result = await callTool(harness, 'orchestra_scout', { text: 'q' })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('did not answer')
  })

  test('a pin is dispatched even when quarantine emptied the catalog around it', async () => {
    // The end-to-end form of the dead end. Every model is in the failure store,
    // so detection has nothing: the role's model comes from the pin or from
    // nowhere at all. In the field this is where the dispatch carried NO model,
    // the session inherited the server's choice, and the turn failed somewhere
    // the report could not point at.
    //
    // Asserted on the `switchModel` CALL rather than on the harness's
    // `sessionModel`, because the harness also sets that field inside
    // `switchAgent` — so the field reads as set even when no model was ever
    // passed, and the test would pass with the bug present.
    const harness = await loadedWithQuarantine({ roles: { advisor: 'anthropic/deep-free' } })
    harness.sessionReplies['review'] = 'VERDICT: approve'

    await callTool(harness, 'orchestra_advisor', { text: 'review' })

    expect(harness.calls).toContain('session.switchModel:anthropic/deep-free')
  })

  test('a dispatch never leaves the model unset while one is assigned', async () => {
    // The general form. A session with no model runs on the server's choice, not
    // this plugin's, and the resulting failure names neither.
    const harness = await loaded()
    harness.sessionReplies['q'] = 'a'

    await callTool(harness, 'orchestra_scout', { text: 'q' })

    expect(harness.calls.some((entry: string) => entry.startsWith('session.switchModel:'))).toBe(true)
  })

  test('an empty question is refused without opening a session', async () => {
    const harness = await loaded()
    const result = await callTool(harness, 'orchestra_scout', {})
    expect(result.content[0]?.text).toContain('question is required')
    expect(harness.removedSessions.length).toBe(0)
  })

  test('registration can be turned off', async () => {
    // Credentials that permit child sessions should keep the host's own path and
    // not gain a second mechanism they did not ask for.
    const harness = await loaded({ sessionDelegate: false })
    expect(harness.registeredTools.size).toBe(0)
  })
})

describe('delegation without session.remove', () => {
  test('a delegation that would succeed still returns its reply', async () => {
    const harness = createPluginHarness({ models: MODELS, omit: ['session.remove'] })
    await entry.setup(harness.ctx)
    await harness.settle()
    harness.sessionReplies['where is X?'] = 'src/a.ts:12 is the definition'

    // The teardown runs in a `finally` that attaches `.catch`. An adapter
    // that threw synchronously would bypass it and turn this success into a
    // thrown error, discarding the reply it was about to return.
    const result = await callTool(harness, 'orchestra_scout', { text: 'where is X?' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('src/a.ts:12')
  })
})
