/**
 * The builder's `subagent` call, and who pays when the host refuses it.
 *
 * The host's own launch opens a child session, which a free-tier credential
 * rejects while the same model answers an ordinary session. That made the most
 * natural call in the builder's prompt the one that always failed — and, worse,
 * the refusal was charged to the model, so the dispatch chain then skipped a
 * model that had been answering all along.
 *
 * Two separate defects, so two halves below: the call is rerouted, and the
 * refusal stops being attributed to a model it says nothing about.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import plugin from '../index'
import type { PluginDefinitionLike } from '../src/plugin-types'
import type { FailureRecord } from '../src/quarantine'
import { isCredentialRefusal } from '../src/quarantine'
import { model } from './fixture'
import type { PluginHarness, PluginHarnessOptions } from './harness'
import { createPluginHarness, invocation } from './harness'

const entry = plugin as PluginDefinitionLike

const CATALOG = [model('cheap', 1, 5), model('dear', 15, 75)]

/** The host's refusal, verbatim from a real transcript. */
const CREDENTIAL_REFUSAL =
  "Subagent failed (sessionID: ses_x): OpenCode's free tier can only be used from within OpenCode"
/** A model that is simply gone. Must keep being attributed to the model. */
const MODEL_REFUSAL = 'Model exo-free has been deprecated.'

let harness: PluginHarness | undefined
let teardown: undefined | (() => void)

async function loaded(options: PluginHarnessOptions = {}, pluginOptions: Record<string, unknown> = {}) {
  const created = createPluginHarness({ models: CATALOG, options: pluginOptions, ...options })
  harness = created
  teardown = await entry.setup(created.ctx)
  await created.settle()
  return created
}

afterEach(async () => {
  if (typeof teardown === 'function') await teardown()
  await harness?.disposeAll()
  teardown = undefined
  harness = undefined
})

/** A host `subagent` tool whose native launch throws `failure`. */
function hostSubagent(failure: unknown) {
  return [
    {
      id: 'subagent',
      execute: async () => {
        throw failure
      }
    }
  ]
}

function wrappedSubagent(created: PluginHarness) {
  const tool = created.registeredTools.get('subagent')
  if (!tool) throw new Error('the host subagent tool was not exposed to the plugin')
  return tool.execute as (
    input: unknown,
    context?: { sessionID?: string }
  ) => Promise<{
    content: { text: string }[]
    isError?: boolean
  }>
}

describe('the host subagent launch', () => {
  test('is wrapped so a credential refusal reroutes over an ordinary session', async () => {
    const created = await loaded({ hostTools: hostSubagent(new Error(CREDENTIAL_REFUSAL)) })
    created.sessionReplies['where is X?'] = 'src/a.ts:12'

    expect(created.updatedTools).toContain('subagent')

    const result = await wrappedSubagent(created)({
      agent: 'scout',
      description: 'repo context',
      prompt: 'where is X?'
    })

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('src/a.ts:12')
    // Proof it ran here rather than through the child session that was refused.
    expect(created.calls.some(call => call.startsWith('session.switchAgent:scout'))).toBe(true)
  })

  test('leaves the native launch alone when it works', async () => {
    const native = async () => ({ content: [{ type: 'text', text: 'from the child session' }] })
    const created = await loaded({ hostTools: [{ id: 'subagent', execute: native }] })

    const result = await wrappedSubagent(created)({ agent: 'scout', prompt: 'where is X?' })

    expect(result.content[0]?.text).toBe('from the child session')
    // No session was opened, so the native path is genuinely intact.
    expect(created.calls.filter(call => call.startsWith('session.switchAgent:'))).toHaveLength(0)
  })

  test('rethrows a failure that is not a credential refusal', async () => {
    const created = await loaded({ hostTools: hostSubagent(new Error('3 tests failed')) })

    // Not swallowed: a broken task must still read as a broken task, not as a reroute.
    expect(wrappedSubagent(created)({ agent: 'scout', prompt: 'where is X?' })).rejects.toThrow('3 tests failed')
  })

  test('rethrows a credential refusal for an agent this plugin does not run', async () => {
    const created = await loaded({ hostTools: hostSubagent(new Error(CREDENTIAL_REFUSAL)) })

    // `general` is not an orchestra role, so there is nothing to reroute to.
    expect(wrappedSubagent(created)({ agent: 'general', prompt: 'where is X?' })).rejects.toThrow(CREDENTIAL_REFUSAL)
  })

  test('the builder cannot be rerouted to itself', async () => {
    const created = await loaded({ hostTools: hostSubagent(new Error(CREDENTIAL_REFUSAL)) })

    expect(wrappedSubagent(created)({ agent: 'builder', prompt: 'where is X?' })).rejects.toThrow(CREDENTIAL_REFUSAL)
  })

  test('a missing prompt is a refusal, not an empty delegation', async () => {
    const created = await loaded({ hostTools: hostSubagent(new Error(CREDENTIAL_REFUSAL)) })

    expect(wrappedSubagent(created)({ agent: 'scout' })).rejects.toThrow(CREDENTIAL_REFUSAL)
  })
})

describe('attributing a refusal', () => {
  test('a credential refusal from an unowned session never reaches the store', async () => {
    const created = await loaded()
    await created.fireSessionRetry({
      sessionID: 'ses_child_from_the_host',
      model: { providerID: 'anthropic', id: 'cheap' },
      error: { type: 'AI.Error', message: CREDENTIAL_REFUSAL },
      attempt: 1
    })
    await created.settle()

    expect(created.store.get('quarantine') ?? {}).toEqual({})
  })

  test('the same refusal on a session this plugin opened is recorded', async () => {
    const created = await loaded({ hostTools: hostSubagent(new Error(CREDENTIAL_REFUSAL)) })
    created.sessionReplies['where is X?'] = 'src/a.ts:12'
    await wrappedSubagent(created)({ agent: 'scout', prompt: 'where is X?' })

    // The delegation failed above, so this plugin did own the session it ran in.
    await created.fireSessionRetry({
      sessionID: created.openedSessions[0]!,
      model: { providerID: 'anthropic', id: 'cheap' },
      error: { type: 'AI.Error', message: CREDENTIAL_REFUSAL },
      attempt: 1
    })
    await created.settle()

    const stored = created.store.get('quarantine') as Record<string, FailureRecord>
    expect(Object.keys(stored)).toEqual(['anthropic/cheap'])
    expect(stored['anthropic/cheap']?.kind).toBe('rejected')
  })

  test('a model that is genuinely gone is still attributed, from any session', async () => {
    const created = await loaded()
    await created.fireSessionRetry({
      sessionID: 'ses_child_from_the_host',
      model: { providerID: 'anthropic', id: 'cheap' },
      error: { type: 'AI.Error', message: MODEL_REFUSAL },
      attempt: 1
    })
    await created.settle()

    const stored = created.store.get('quarantine') as Record<string, FailureRecord>
    // The exemption is for the credential, not for child sessions as such.
    expect(stored['anthropic/cheap']?.kind).toBe('terminal')
  })
})

describe('what /orchestra says about it', () => {
  test('says nothing while the wrapper is in place and unused', async () => {
    const created = await loaded({ hostTools: hostSubagent(new Error(CREDENTIAL_REFUSAL)) })

    await created.runCommand('orchestra', invocation())
    const report = created.lastPrompted ?? ''

    expect(report).not.toContain('does not expose')
    expect(report).not.toContain('rerouted')
  })

  test('counts a reroute so a silent substitution cannot happen', async () => {
    const created = await loaded({ hostTools: hostSubagent(new Error(CREDENTIAL_REFUSAL)) })
    created.sessionReplies['where is X?'] = 'src/a.ts:12'
    await wrappedSubagent(created)({ agent: 'scout', prompt: 'where is X?' })

    await created.runCommand('orchestra', invocation())

    expect(created.lastPrompted).toContain('rerouted over an ordinary session')
  })

  test('reports an unwrappable host rather than pretending delegation is fine', async () => {
    // No `hostTools`: the id the plugin wants does not exist, so `update` finds nothing.
    const created = await loaded()

    await created.runCommand('orchestra', invocation())

    expect(created.lastPrompted).toContain('does not expose')
  })
})

describe('the credential-refusal predicate', () => {
  test('matches the host wording in both the error and the plain-string form', () => {
    expect(isCredentialRefusal({ message: CREDENTIAL_REFUSAL })).toBe(true)
    expect(isCredentialRefusal(CREDENTIAL_REFUSAL)).toBe(true)
  })

  test('does not match a model fault that merely mentions OpenCode', () => {
    // Negative control: a loose pattern here would exempt every model in the store.
    expect(isCredentialRefusal({ message: MODEL_REFUSAL })).toBe(false)
    expect(isCredentialRefusal({ message: 'model opencode/exo-free was withdrawn' })).toBe(false)
    expect(isCredentialRefusal(undefined)).toBe(false)
    expect(isCredentialRefusal('')).toBe(false)
  })

  test('matches every phrasing the provider is known to use', () => {
    // The miss here is not a degraded reroute, it is a DISABLED one: a wording the
    // predicate does not know re-throws as a hard subagent failure and the session
    // fallback never runs. The observed wording was "free tier must be used from
    // within opencode", which the previous pattern set did not match — so the
    // panel reported "did not answer" for what was a routing miss.
    //
    // Every observed phrasing is asserted, not just the one in CREDENTIAL_REFUSAL.
    const observed = [
      "OpenCode's free tier can only be used from within OpenCode",
      'free tier must be used from within opencode',
      'free tier can only be used from within OpenCode',
      'This model must be used from inside opencode',
      'free tier can only be used by OpenCode',
      'Your free tier must be used within OpenCode'
    ]
    for (const message of observed) {
      expect({ message, matched: isCredentialRefusal(message) }).toEqual({ message, matched: true })
    }
  })

  test('still refuses ordinary faults that are not about the credential', () => {
    // The widened patterns must not swallow these, or a genuinely broken model
    // gets excused and the store fills with entries it should never hold.
    for (const message of [
      'Model exo-free has been deprecated',
      'Rate limit exceeded. Please try again later.',
      'Endpoint is unavailable.',
      'Upstream request failed',
      'the agent produced no reply',
      'context length exceeded',
      'you have 0 credits remaining, add credits to continue'
    ]) {
      expect({ message, matched: isCredentialRefusal(message) }).toEqual({ message, matched: false })
    }
  })
})
