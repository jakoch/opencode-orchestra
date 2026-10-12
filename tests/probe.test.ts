/**
 * Tests for `/orchestra probe`.
 *
 * The load-bearing property is the three-way verdict. A probe that cannot tell
 * "refused" from "we never got there" is worse than no probe, because it would
 * quarantine healthy models on a bad network and teach the user to ignore the
 * one signal meant to be trustworthy. Those two cases are asserted apart
 * throughout.
 */

import { describe, expect, test } from 'bun:test'
import type { GenerateLike } from '../src/probe'
import { classifyProbeError, deadRoles, describeProbe, probeAssignments, suggestPin } from '../src/probe'
import type { ModelRef, RoleName } from '../src/types'
import { ROLES } from '../src/types'
import { SERVER_DEFAULT_DIRECTORY } from './harness'

/** Fails only the listed refs, so one role can be dead while the others work. */
function generateWhere(failures: Record<string, string>, okText = 'ok'): GenerateLike {
  return {
    async text(input) {
      const ref = `${input.model?.providerID}/${input.model?.id}`
      const failure = failures[ref]
      if (failure) throw new Error(failure)
      return { text: okText }
    }
  }
}

const builder: ModelRef = { providerID: 'opencode', id: 'builder-free' }
const scout: ModelRef = { providerID: 'opencode', id: 'scout-free' }
const advisor: ModelRef = { providerID: 'opencode', id: 'advisor-free' }
const skeptic: ModelRef = { providerID: 'opencode', id: 'skeptic-free' }

/**
 * One assignment per role, built from `ROLES`.
 *
 * A hand-written three-role object is a trap here rather than a shortcut:
 * `probeAssignments` walks `ROLES`, so a missing key does not fail the call, it
 * reports `unverified` for a role nobody assigned — which reads exactly like a
 * dead model and quietly inverts the meaning of the test.
 */
const assignments = Object.fromEntries(ROLES.map(role => [role, { builder, scout, advisor, skeptic }[role]])) as Record<
  RoleName,
  ModelRef
>

/**
 * A session double for the fallback route, recording where each session was born
 * and every `move`.
 *
 * Models the host rather than the plugin's intent: a create with no `location`
 * lands in the server's default directory, which is what makes the difference
 * between this route being correct and being a phantom workspace observable.
 */
function recordingSession(
  born: (string | undefined)[],
  moves: string[] = [],
  options: { honourLocation?: boolean } = {}
) {
  let counter = 0
  return {
    create: async (input?: { location?: { directory: string } }) => {
      counter += 1
      const directory =
        options.honourLocation === false
          ? SERVER_DEFAULT_DIRECTORY
          : (input?.location?.directory ?? SERVER_DEFAULT_DIRECTORY)
      born.push(directory)
      return { id: `ses_probe_${counter}`, location: { directory } }
    },
    move: async (input: { directory: string }) => {
      moves.push(input.directory)
    },
    switchAgent: async () => undefined,
    switchModel: async () => undefined,
    prompt: async () => undefined,
    wait: async () => undefined,
    remove: async () => undefined,
    context: async () => []
  }
}

describe('probeAssignments', () => {
  test('reports ok for a model that answers', async () => {
    const results = await probeAssignments({
      assignments,
      generate: generateWhere({})
    })
    expect(results.every(r => r.verdict === 'ok')).toBe(true)
    expect(results).toHaveLength(ROLES.length)
  })

  test('reports refused, not unverified, when the provider rejects the request', async () => {
    const results = await probeAssignments({
      assignments,
      generate: generateWhere({
        'opencode/scout-free': "OpenCode's free tier can only be used from within OpenCode"
      })
    })
    const scoutResult = results.find(r => r.role === 'scout')
    expect(scoutResult?.verdict).toBe('refused')
    expect(scoutResult?.kind).toBe('rejected')
    expect(scoutResult?.detail).toContain('free tier')
  })

  test('classifies both observed free-tier wordings as rejections', async () => {
    const results = await probeAssignments({
      assignments: {
        builder: { providerID: 'opencode', id: 'a' },
        scout: { providerID: 'opencode', id: 'b' },
        advisor: { providerID: 'opencode', id: 'c' }
      },
      generate: generateWhere({
        'opencode/a': "OpenCode's free tier can only be used from within OpenCode",
        'opencode/b': 'opencode error: session error. free tier can only be used by opencode.'
      })
    })
    expect(results.find(r => r.role === 'builder')?.kind).toBe('rejected')
    expect(results.find(r => r.role === 'scout')?.kind).toBe('rejected')
    expect(results.find(r => r.role === 'advisor')?.verdict).toBe('ok')
  })

  test('a timeout is unverified, never refused', async () => {
    // The distinction the whole module exists for: no answer is not a verdict.
    const results = await probeAssignments({
      assignments,
      generate: {
        text: () =>
          new Promise(() => {
            /* never settles: this is the timeout path under test */
          })
      }, // never settles
      options: { timeoutMs: 20 }
    })
    expect(results.every(r => r.verdict === 'unverified')).toBe(true)
    expect(results.every(r => r.kind === undefined)).toBe(true)
    expect(deadRoles(results)).toEqual([])
  })

  test('a role with no model is unverified, not failed', async () => {
    const results = await probeAssignments({
      assignments: { builder },
      generate: generateWhere({})
    })
    const scoutResult = results.find(r => r.role === 'scout')
    expect(scoutResult?.verdict).toBe('unverified')
    expect(scoutResult?.detail).toContain('no model assigned')
  })

  test('probes concurrently rather than serially', async () => {
    // Three sequential 30ms probes would take ~90ms; concurrent take ~30ms.
    const slow: GenerateLike = {
      text: () => new Promise(resolve => setTimeout(() => resolve({ text: 'ok' }), 30))
    }
    const started = Date.now()
    await probeAssignments({ assignments, generate: slow })
    expect(Date.now() - started).toBeLessThan(80)
  })

  test('one dead model does not prevent the others being probed', async () => {
    const results = await probeAssignments({
      assignments,
      generate: generateWhere({ 'opencode/scout-free': 'deprecated' })
    })
    expect(results.find(r => r.role === 'builder')?.verdict).toBe('ok')
    expect(results.find(r => r.role === 'advisor')?.verdict).toBe('ok')
    expect(results.find(r => r.role === 'scout')?.verdict).toBe('refused')
  })

  test('the session-backed route opens its session in the project', async () => {
    // The bug this exists for. `generate.text` is refused on a free tier, so
    // every probe ends up on this route — and the route used to `create` with no
    // location and never `move`. A session born in the server's default
    // directory is a session in the wrong project: prompting it boots that
    // location on the server, and it outlives the session once it is removed.
    // That phantom workspace is what the host's `session.location-missing`
    // dialog and its folder switcher trip over.
    const born: (string | undefined)[] = []
    await probeAssignments({
      assignments: { builder },
      generate: generateWhere({ 'opencode/builder-free': 'free tier can only be used' }),
      session: recordingSession(born),
      directory: '/repo'
    })
    expect(born).toEqual(['/repo'])
  })

  test('the session-backed route moves a session the host placed elsewhere', async () => {
    const born: (string | undefined)[] = []
    const moves: string[] = []
    await probeAssignments({
      assignments: { builder },
      generate: generateWhere({ 'opencode/builder-free': 'free tier can only be used' }),
      session: recordingSession(born, moves, { honourLocation: false }),
      directory: '/repo'
    })
    expect(moves).toEqual(['/repo'])
  })
})

describe('classifyProbeError', () => {
  test('treats a free-tier refusal as a rejection', () => {
    expect(classifyProbeError(new Error('free tier can only be used by opencode')).kind).toBe('rejected')
  })

  test('treats an unknown provider error as terminal', () => {
    expect(classifyProbeError(new Error('model has been deprecated')).kind).toBe('terminal')
  })

  test('a slow model is unverified, never refused', () => {
    // Observed: a model that took 13s to answer "hello" was reported as
    // refused, then dropped from detection and never tried again. Slow is not
    // broken, and the distinction decides whether the model stays in play.
    for (const message of [
      'request timed out',
      'deadline exceeded',
      'model is too slow right now',
      'upstream timed out'
    ]) {
      expect(classifyProbeError(new Error(message)).verdict).toBe('unverified')
    }
  })

  test('a loaded or failing gateway is unverified, never refused', () => {
    for (const message of [
      'rate limit exceeded',
      '429 Too Many Requests',
      'model overloaded',
      '503 service unavailable',
      '502 bad gateway',
      'internal server error'
    ]) {
      expect(classifyProbeError(new Error(message)).verdict).toBe('unverified')
    }
  })

  test('a dropped connection is unverified, never refused', () => {
    for (const message of ['socket hang up', 'ECONNRESET', 'stream ended unexpectedly']) {
      expect(classifyProbeError(new Error(message)).verdict).toBe('unverified')
    }
  })

  test('an unverified failure carries no kind, so nothing is recorded against the model', () => {
    // `kind` drives the durable failure store; a slow model must leave no trace.
    expect(classifyProbeError(new Error('request timed out')).kind).toBeUndefined()
  })

  test('an explicit refusal still wins over the slow/error patterns', () => {
    expect(classifyProbeError(new Error('free tier can only be used by opencode')).verdict).toBe('refused')
  })

  test('handles a non-Error throw', () => {
    expect(classifyProbeError('boom').verdict).toBe('refused')
    expect(classifyProbeError({ message: 'boom' }).detail).toBe('boom')
  })

  test('bounds the detail so a huge provider message cannot flood the report', () => {
    expect(classifyProbeError(new Error('x'.repeat(5000))).detail.length).toBeLessThanOrEqual(200)
  })
})

describe('deadRoles', () => {
  test('lists only refused roles', async () => {
    const results = await probeAssignments({
      assignments,
      generate: generateWhere({ 'opencode/scout-free': 'free tier can only be used' })
    })
    expect(deadRoles(results)).toEqual(['scout'])
  })

  test('does not list unverified roles, since there is nothing to act on', async () => {
    const results = await probeAssignments({
      assignments,
      generate: {
        text: () =>
          new Promise(() => {
            /* never settles: this is the timeout path under test */
          })
      },
      options: { timeoutMs: 20 }
    })
    expect(deadRoles(results)).toEqual([])
  })
})

describe('suggestPin', () => {
  test('suggests a working model when a role is refused', async () => {
    const results = await probeAssignments({
      assignments,
      generate: generateWhere({ 'opencode/scout-free': 'free tier can only be used' })
    })
    const pin = suggestPin(results, 'scout')
    // The donor is the first role that answered. Any healthy model beats a
    // refused one, so which of builder/advisor is picked is not the point.
    expect(pin).toContain('"scout"')
    expect(pin).toMatch(/builder-free|advisor-free/)
  })

  test('never suggests the refused model itself', async () => {
    const results = await probeAssignments({
      assignments,
      generate: generateWhere({ 'opencode/scout-free': 'free tier can only be used' })
    })
    expect(suggestPin(results, 'scout')).not.toContain('scout-free')
  })

  test('suggests nothing when the role is healthy', async () => {
    const results = await probeAssignments({
      assignments,
      generate: generateWhere({})
    })
    expect(suggestPin(results, 'scout')).toBeUndefined()
  })

  test('suggests nothing when every model is dead', async () => {
    // Built from the assignment map so "every model" stays true when a role is
    // added. Listing the dead refs by hand left the new role alive and the test
    // asserted the opposite of its own name.
    const dead = Object.fromEntries(
      Object.values(assignments).map(model => [`${model.providerID}/${model.id}`, 'gone'])
    )
    const results = await probeAssignments({ assignments, generate: generateWhere(dead) })
    expect(results.every(result => result.verdict !== 'ok')).toBe(true)
    expect(suggestPin(results, 'scout')).toBeUndefined()
  })
})

describe('describeProbe', () => {
  test('says answered for a healthy model', async () => {
    const [result] = await probeAssignments({ assignments: { builder }, generate: generateWhere({}) })
    expect(describeProbe(result!)).toContain('answered')
  })

  test('says refused for a dead model', async () => {
    const results = await probeAssignments({
      assignments: { scout },
      generate: generateWhere({ 'opencode/scout-free': 'free tier can only be used' })
    })
    expect(describeProbe(results.find(r => r.role === 'scout')!)).toContain('refused')
  })

  test('does not claim a model is broken when it was merely unreachable', async () => {
    const results = await probeAssignments({
      assignments: { builder },
      generate: {
        text: () =>
          new Promise(() => {
            /* never settles: this is the timeout path under test */
          })
      },
      options: { timeoutMs: 20 }
    })
    expect(describeProbe(results.find(r => r.role === 'builder')!)).toContain('not verified')
  })
})

describe('missing generate.text', () => {
  test('an absent cheap route is unverified with the capability named, never refused', async () => {
    const results = await probeAssignments({ assignments, generate: undefined })
    expect(results).toHaveLength(ROLES.length)
    for (const result of results) {
      expect(result.verdict).toBe('unverified')
      expect(result.detail).toContain('generate.text')
    }
    expect(deadRoles(results)).toEqual([])
  })
})
