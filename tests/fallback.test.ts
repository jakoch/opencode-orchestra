/**
 * The fallback chain at dispatch.
 *
 * `resolveRoles` used to rank every candidate and keep only the winner. A model
 * the provider refuses looked exactly like a model that works, from every angle
 * the plugin could see: the assignment said "detected", the report said
 * "unverified", and the builder's turn died with a message about someone else's
 * credentials. The chain is what turns that into something a dispatch can act
 * on — and the tests below are mostly about when it must *not* act, because a
 * fallback that fires on every error is worse than no fallback: it re-runs
 * genuinely broken work and hides the error that would have explained it.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import plugin from '../index'
import type { PluginDefinitionLike } from '../src/plugin-types'
import type { FailureRecord } from '../src/quarantine'
import { looksLikeTransportFault, rejectedRefs } from '../src/quarantine'
import type { ResolvedRoles } from '../src/roles'
import { fallbackChain, resolveRoles, score } from '../src/roles'
import type { ResolveOutput } from '../src/types'
import { ROLES } from '../src/types'
import { model } from './fixture'
import type { PluginHarness, PluginHarnessOptions } from './harness'
import { createPluginHarness, invocation } from './harness'

const entry = plugin as PluginDefinitionLike

/**
 * Four models that differ in nothing but price.
 *
 * Same limits, same release date, and names that carry no family keyword, so
 * every signal except cheapness is identical and the ranking is decided purely
 * by cost: `tier-one` > `tier-two` > `tier-three` > `tier-four`. Asserted
 * rather than assumed — the ordering test checks it against `score` itself.
 */
const CATALOG = [
  model('tier-one', 1, 5),
  model('tier-two', 2, 10),
  model('tier-three', 3, 15),
  model('tier-four', 15, 75)
]

/**
 * Pin the two heavy roles so `scout` takes the cheapest model.
 *
 * Detection otherwise deliberately moves roles onto distinct models, which would
 * make `scout`'s chain start at rank 3 — true, but it makes every assertion
 * below about a fallback read as a claim about roles sharing a model.
 */
const PINNED = { roles: { advisor: 'anthropic/tier-four', builder: 'anthropic/tier-three' } }

const REFUSAL = "OpenCode's free tier can only be used from within OpenCode"
/** A genuine task fault: the work is broken, so no model would answer it. */
const TASK_ERROR = 'bun test: 3 tests failed. Expected 2 to be 3'

const now = Date.now()

let harness: PluginHarness | undefined
let teardown: undefined | (() => void)

async function loaded(options: PluginHarnessOptions = {}, pluginOptions: Record<string, unknown> = PINNED) {
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

/** Calls a registered delegation tool the way the host would. */
async function callTool(created: PluginHarness, name: string, text: string) {
  const tool = created.registeredTools.get(name)
  if (!tool) throw new Error(`tool ${name} was not registered`)
  return (tool.execute as (input: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)({ text })
}

/** Refs a dispatch was actually pointed at, in order. */
function dispatched(created: PluginHarness): string[] {
  return created.calls
    .filter(call => call.startsWith('session.switchModel:'))
    .map(call => call.slice('session.switchModel:'.length))
}

function record(ref: string, extra: Partial<FailureRecord>): FailureRecord {
  return {
    ref,
    reason: extra.kind === 'rejected' ? REFUSAL : 'model is deprecated upstream',
    occurrences: 1,
    firstSeen: now,
    lastSeen: now,
    ...extra
  }
}

describe('the ranked order', () => {
  test('is returned per role, best score first', () => {
    const resolved = resolveRoles({ catalog: CATALOG })
    const ranked = resolved.ranked!

    expect(ranked.scout!.map(entry => entry.ref)).toEqual([
      'anthropic/tier-one',
      'anthropic/tier-two',
      'anthropic/tier-three',
      'anthropic/tier-four'
    ])
    for (const role of ['builder', 'scout', 'advisor'] as const) {
      const order = ranked[role]!
      expect(order).toHaveLength(4)
      for (let index = 1; index < order.length; index++) {
        expect(order[index - 1]!.score).toBeGreaterThanOrEqual(order[index]!.score)
      }
    }
  })

  test('carries the same score the scorer produced, not a re-derived one', () => {
    const resolved = resolveRoles({ catalog: CATALOG })
    for (const entry of resolved.ranked!.scout!) {
      const signals = resolved.candidates.find(candidate => candidate.ref === entry.ref)!
      expect(entry.score).toBe(score(signals, 'scout'))
    }
  })

  test('is dispatchable: ref, score and an expanded model per step', () => {
    const [best] = resolveRoles({ catalog: CATALOG }).ranked!.scout!
    expect(best!.ref).toBe('anthropic/tier-one')
    expect(best!.model.providerID).toBe('anthropic')
    expect(best!.model.id).toBe('tier-one')
    expect(typeof best!.score).toBe('number')
  })

  test('is present on the empty-catalog path too, as empty chains', () => {
    const resolved = resolveRoles({ catalog: [] })
    // Every role, from ROLES rather than a literal: the empty-catalog shape is
    // exactly where a hand-written `ranked` quietly forgets a new role, and the
    // field is optional so the omission compiles.
    for (const role of ROLES) {
      expect(resolved.ranked?.[role]).toEqual([])
    }
  })
})

describe('ResolveOutput compatibility', () => {
  test('the result still satisfies the shared type callers already use', () => {
    // Compile-time assertion: a `ResolveOutput` variable accepts the result.
    const resolved: ResolveOutput = resolveRoles({ catalog: CATALOG })
    expect(resolved.candidates.length).toBe(4)
    expect(resolved.assignments.scout.role).toBe('scout')
    expect(Array.isArray(resolved.notes)).toBe(true)
    expect(resolved.assignments.builder.runnersUp.length).toBeGreaterThan(0)
  })

  test('a caller that ignores the new field sees the old three fields unchanged', () => {
    const { candidates, assignments, notes } = resolveRoles({ catalog: CATALOG })
    const legacy: ResolveOutput = { candidates, assignments, notes }
    expect(Object.keys(legacy).sort()).toEqual(['assignments', 'candidates', 'notes'])
  })

  test('output with no ranked order degrades to the assigned model alone', () => {
    // What anything persisted or passed around before this change looks like: a
    // perfectly good `ResolveOutput` with nothing extra on it.
    const full = resolveRoles({ catalog: CATALOG })
    const legacy: ResolvedRoles = {
      candidates: full.candidates,
      assignments: full.assignments,
      notes: full.notes
    }
    expect(fallbackChain(legacy, 'scout').map(entry => entry.ref)).toEqual(['anthropic/tier-three'])
  })
})

describe('fallbackChain', () => {
  test('starts at the assignment, not at rank 1', () => {
    // Detection deliberately keeps roles on distinct models, so scout's
    // assignment is rank 3. A chain that opened at rank 1 would dispatch scout
    // on the advisor's model and report a move nobody made.
    const resolved = resolveRoles({ catalog: CATALOG })
    expect(resolved.assignments.scout.model).toMatchObject({ id: 'tier-three' })
    expect(fallbackChain(resolved, 'scout')[0]!.ref).toBe('anthropic/tier-three')
  })

  test('then walks the rest in score order, without repeats', () => {
    const resolved = resolveRoles({ catalog: CATALOG, overrides: PINNED.roles })
    expect(fallbackChain(resolved, 'scout').map(entry => entry.ref)).toEqual([
      'anthropic/tier-one',
      'anthropic/tier-two',
      'anthropic/tier-three',
      'anthropic/tier-four'
    ])
  })

  test('skips blocked and rejected refs, and says which is which', () => {
    const records = {
      'anthropic/tier-two': record('anthropic/tier-two', { blocked: true, kind: 'terminal' }),
      'anthropic/tier-three': record('anthropic/tier-three', { kind: 'rejected' })
    }
    const resolved = resolveRoles({ catalog: CATALOG, overrides: PINNED.roles })
    // The rejected model is still ranked: detection must keep seeing a model that
    // works in the TUI. Only this consumer skips it.
    expect(resolved.ranked!.scout!.map(entry => entry.ref)).toContain('anthropic/tier-three')
    expect(rejectedRefs(records)).toEqual(['anthropic/tier-three'])

    const chain = fallbackChain(resolved, 'scout', ['anthropic/tier-two', ...rejectedRefs(records)])
    expect(chain.map(entry => entry.ref)).toEqual(['anthropic/tier-one', 'anthropic/tier-four'])
  })

  test('is empty when nothing was assigned', () => {
    // The shape a project with no tool-capable model produces: every role falls
    // back to the session model, so there is nothing for a dispatch to walk to.
    const resolved = resolveRoles({ catalog: [] })
    expect(fallbackChain(resolved, 'scout')).toEqual([])
  })
})

describe('looksLikeTransportFault', () => {
  test('recognises the refusals and model-identity failures', () => {
    expect(looksLikeTransportFault(REFUSAL)).toBe(true)
    expect(looksLikeTransportFault('free tier can only be used by opencode')).toBe(true)
    expect(looksLikeTransportFault('model is deprecated upstream')).toBe(true)
    expect(looksLikeTransportFault({ message: 'unknown model', status: 404 })).toBe(true)
    expect(looksLikeTransportFault('socket hang up')).toBe(true)
  })

  test('does not claim task failures, however much they look like provider errors', () => {
    // Every one of these would fire a blind retry and re-run broken work on a
    // second model. `unavailable` and `not found` are the sharpest cases: the
    // lifetime classifier accepts them on their own, and here they are a
    // dependency and a file.
    for (const message of [
      TASK_ERROR,
      'npm registry unavailable',
      'ENOENT: no such file or directory, open src/a.ts',
      'file not found: /repo/missing.ts',
      'invalid syntax in src/broken.ts'
    ]) {
      expect(looksLikeTransportFault(message)).toBe(false)
    }
  })

  test('does not claim a rate limit or a timeout', () => {
    // A sibling model on the same provider and key fails the same way, and a
    // retry doubles the wait rather than shortening it.
    for (const message of [
      'rate limit exceeded',
      '429 Too Many Requests',
      'timed out after 300000ms while prompting'
    ]) {
      expect(looksLikeTransportFault(message)).toBe(false)
    }
  })

  test('treats nothing as no fault', () => {
    expect(looksLikeTransportFault(undefined)).toBe(false)
    expect(looksLikeTransportFault('')).toBe(false)
  })
})

describe('dispatch with a chain', () => {
  test('a dispatch failure retries exactly once and lands on the next candidate', async () => {
    const created = await loaded()
    created.delegateFailures['anthropic/tier-one'] = REFUSAL
    created.sessionReplies['where is X?'] = 'src/a.ts:12'

    const result = await callTool(created, 'orchestra_scout', 'where is X?')

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('src/a.ts:12')
    expect(dispatched(created)).toEqual(['anthropic/tier-one', 'anthropic/tier-two'])
    // Both attempts cleaned up after themselves; a leaked session shows up in the
    // user's list as work in progress that nobody is doing.
    expect(created.removedSessions).toHaveLength(2)
  })

  test('a second failure is a real answer, not another retry', async () => {
    const created = await loaded()
    created.delegateFailures['anthropic/tier-one'] = REFUSAL
    created.delegateFailures['anthropic/tier-two'] = REFUSAL

    const result = await callTool(created, 'orchestra_scout', 'where is X?')

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('did not answer')
    expect(dispatched(created)).toEqual(['anthropic/tier-one', 'anthropic/tier-two'])
  })

  test('a task-shaped failure is not retried', async () => {
    const created = await loaded()
    created.delegateFailures['anthropic/tier-one'] = TASK_ERROR
    created.sessionReplies['where is X?'] = 'src/a.ts:12'

    const result = await callTool(created, 'orchestra_scout', 'where is X?')

    // The answer is the error. Running it again on another model would spend a
    // provider call and a fan-out slot to arrive at the same failure.
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('3 tests failed')
    expect(dispatched(created)).toEqual(['anthropic/tier-one'])
  })

  test('blocked and rejected candidates are both skipped for dispatch', async () => {
    const created = await loaded({
      storage: {
        quarantine: {
          'anthropic/tier-two': record('anthropic/tier-two', { blocked: true, kind: 'terminal' }),
          'anthropic/tier-three': record('anthropic/tier-three', { kind: 'rejected' })
        }
      }
    })
    created.delegateFailures['anthropic/tier-one'] = REFUSAL
    created.sessionReplies['where is X?'] = 'src/a.ts:12'

    const result = await callTool(created, 'orchestra_scout', 'where is X?')

    expect(result.content[0]?.text).toBe('src/a.ts:12')
    // `tier-two` never reaches detection at all; `tier-three` is still in the
    // catalog and still reported, but a dispatch must not walk into the refusal
    // it just escaped.
    expect(dispatched(created)).toEqual(['anthropic/tier-one', 'anthropic/tier-four'])

    await created.runCommand('orchestra', invocation())
    const report = created.lastPrompt()?.text ?? ''
    expect(report).toContain('Rejected models')
    expect(report).toContain('anthropic/tier-three')
  })

  test('the advisor is never retried', async () => {
    const created = await loaded()
    created.delegateFailures['anthropic/tier-four'] = REFUSAL
    created.sessionReplies['review'] = 'VERDICT: approve'

    const result = await callTool(created, 'orchestra_advisor', 'review')

    // The advisor is called rarely and on a deliberate pin. A fallback here would
    // answer the question with a model the user never chose, which hides a bad
    // pin — the one thing a pin is for.
    expect(result.isError).toBe(true)
    expect(dispatched(created)).toEqual(['anthropic/tier-four'])
  })

  test('a healthy dispatch is untouched', async () => {
    const created = await loaded()
    created.sessionReplies['where is X?'] = 'src/a.ts:12'

    const result = await callTool(created, 'orchestra_scout', 'where is X?')

    expect(result.content[0]?.text).toBe('src/a.ts:12')
    expect(dispatched(created)).toEqual(['anthropic/tier-one'])
  })
})

describe('the report', () => {
  test('says a role was retried, so a silently-moved role is visible', async () => {
    const created = await loaded()
    created.delegateFailures['anthropic/tier-one'] = REFUSAL
    created.sessionReplies['where is X?'] = 'src/a.ts:12'
    await callTool(created, 'orchestra_scout', 'where is X?')

    await created.runCommand('orchestra', invocation())
    const report = created.lastPrompt()?.text ?? ''

    expect(report).toContain('The Scout failed at dispatch on `anthropic/tier-one`')
    expect(report).toContain('was retried once on `anthropic/tier-two`, which answered')
  })

  test('says a role was not retried, and why', async () => {
    const created = await loaded()
    created.delegateFailures['anthropic/tier-one'] = TASK_ERROR
    await callTool(created, 'orchestra_scout', 'where is X?')

    await created.runCommand('orchestra', invocation())
    const report = created.lastPrompt()?.text ?? ''

    expect(report).toContain('The Scout failed at dispatch on `anthropic/tier-one` and was not retried')
    expect(report).toContain('reads as the task rather than the model')
  })

  test('reports a retried role whose retry also failed', async () => {
    const created = await loaded()
    created.delegateFailures['anthropic/tier-one'] = REFUSAL
    created.delegateFailures['anthropic/tier-two'] = REFUSAL
    await callTool(created, 'orchestra_scout', 'where is X?')

    await created.runCommand('orchestra', invocation())
    const report = created.lastPrompt()?.text ?? ''

    expect(report).toContain('was retried once on `anthropic/tier-two`, which also failed')
  })

  test('says nothing about dispatch when nothing failed', async () => {
    const created = await loaded()
    created.sessionReplies['where is X?'] = 'src/a.ts:12'
    await callTool(created, 'orchestra_scout', 'where is X?')

    await created.runCommand('orchestra', invocation())
    expect(created.lastPrompt()?.text ?? '').not.toContain('failed at dispatch')
  })
})
