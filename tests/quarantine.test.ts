/**
 * Failure classification.
 *
 * The class of bug this guards against is silent: a message that matches nothing
 * is classified `ignore`, the failure is never recorded, and the resolver hands
 * the same dead model back tomorrow while the session quietly stops delegating.
 * So the assertions here are about which wordings reach which bucket, not about
 * the internals that do the matching.
 */

import { describe, expect, test } from 'bun:test'
import type { FailureRecord } from '../src/quarantine'
import {
  blockedRefs,
  classifyFailure,
  describeQuarantine,
  describeRejections,
  recordFailure,
  SOFT_FAILURE_THRESHOLD
} from '../src/quarantine'

const REF = 'opencode/ling-3.1-flash-free'
const NOW = 1_700_000_000_000

/** Both wordings observed live, verbatim from the retry hook. */
const OBSERVED_REJECTIONS = [
  "Subagent failed: OpenCode's free tier can only be used from within OpenCode",
  'free tier can only be used by opencode.'
]

describe('classifyFailure: provider rejections', () => {
  test('both observed free-tier messages are rejections, not noise', () => {
    for (const message of OBSERVED_REJECTIONS) {
      expect(classifyFailure({ type: 'ProviderAuthError', message })).toBe('rejected')
    }
  })

  test('a rejection is not a terminal error and not a rate limit', () => {
    // Guards the regression directly: either of these verdicts would block a model
    // that works in the TUI, and the record lasts 14 days.
    for (const message of OBSERVED_REJECTIONS) {
      expect(classifyFailure({ message })).not.toBe('terminal')
      expect(classifyFailure({ message })).not.toBe('soft')
    }
  })
})

describe('classifyFailure: everything else keeps its old verdict', () => {
  test('genuine terminal errors still read as terminal', () => {
    for (const message of [
      'model has been deprecated',
      'model not found',
      'no such model: gpt-9',
      'this model is unavailable',
      'the model does not exist'
    ]) {
      expect(classifyFailure({ message })).toBe('terminal')
    }
  })

  test('404 and 410 are terminal without any wording to go on', () => {
    expect(classifyFailure({ message: 'gone', status: 404 })).toBe('terminal')
    expect(classifyFailure({ message: 'gone', status: 410 })).toBe('terminal')
  })

  test('rate limiting stays soft, by wording or by status', () => {
    expect(classifyFailure({ message: 'rate limit exceeded' })).toBe('soft')
    expect(classifyFailure({ message: 'too many requests' })).toBe('soft')
    expect(classifyFailure({ message: 'monthly quota used up' })).toBe('soft')
    expect(classifyFailure({ message: 'slow down', status: 429 })).toBe('soft')
  })

  test('a transient error is still ignored, not recorded as a rejection', () => {
    expect(classifyFailure({ message: 'socket hang up' })).toBe('ignore')
    expect(classifyFailure({ type: '', message: '' })).toBe('ignore')
  })
})

describe('recordFailure: rejections are remembered but not blocked', () => {
  test('a rejected failure is recorded and does not set blocked', () => {
    const result = recordFailure({}, REF, { message: OBSERVED_REJECTIONS[0] }, NOW)
    expect(result.kind).toBe('rejected')
    expect(result.records[REF]).toBeDefined()
    expect(result.records[REF].blocked).toBeFalsy()
    expect(result.records[REF].occurrences).toBe(1)
    expect(result.records[REF].kind).toBe('rejected')
    expect(result.records[REF].reason).toContain('free tier')
  })

  test('a rejection does not trigger re-detection, so the report is what changes', () => {
    const first = recordFailure({}, REF, { message: OBSERVED_REJECTIONS[0] }, NOW)
    expect(first.changed).toBe(false)
    // Repeating it must not accumulate into a block either.
    const second = recordFailure(first.records, REF, { message: OBSERVED_REJECTIONS[0] }, NOW + 1)
    expect(second.records[REF].occurrences).toBe(2)
    expect(second.records[REF].blocked).toBeFalsy()
    expect(second.changed).toBe(false)
  })

  test('a rejected model is excluded from blockedRefs', () => {
    const records = recordFailure({}, REF, { message: OBSERVED_REJECTIONS[0] }, NOW).records
    expect(blockedRefs(records)).toEqual([])
  })

  test('rejections survive a storage round-trip, which is the whole point', () => {
    // The store is plain JSON in ctx.storage, so what classification survives
    // serialization is what the next plugin load gets to read.
    const written = recordFailure({}, REF, { message: OBSERVED_REJECTIONS[1] }, NOW).records
    const reloaded = JSON.parse(JSON.stringify(written)) as Record<string, FailureRecord>
    expect(reloaded[REF].kind).toBe('rejected')
    expect(blockedRefs(reloaded)).toEqual([])
    expect(describeRejections(reloaded)).toHaveLength(1)
  })

  test('a rejection after a block does not hand a dead model back', () => {
    let records = recordFailure({}, REF, { message: 'model has been deprecated' }, NOW).records
    records = recordFailure(records, REF, { message: OBSERVED_REJECTIONS[0] }, NOW + 1).records
    expect(blockedRefs(records)).toEqual([REF])
    // It stays reported as a block, not as a rejection: it is excluded.
    expect(describeQuarantine(records)).toHaveLength(1)
    expect(describeRejections(records)).toEqual([])
  })
})

describe('recordFailure: terminal errors still block immediately', () => {
  test('one deprecated response is enough', () => {
    const result = recordFailure({}, 'anthropic/claude-opus-4-1', { message: 'model has been deprecated' }, NOW)
    expect(result.kind).toBe('terminal')
    expect(result.records['anthropic/claude-opus-4-1'].blocked).toBe(true)
    expect(result.changed).toBe(true)
    expect(blockedRefs(result.records)).toEqual(['anthropic/claude-opus-4-1'])
  })

  test('a 404 with no wording blocks too', () => {
    const result = recordFailure({}, 'openai/gpt-5.2', { message: '', status: 404 }, NOW)
    expect(result.records['openai/gpt-5.2'].blocked).toBe(true)
  })
})

describe('recordFailure: rate limits need three occurrences', () => {
  const rateLimit = { message: 'rate limit exceeded' }

  test('the first two rate limits are counted but not blocked', () => {
    let records: Record<string, FailureRecord> = {}
    for (let attempt = 1; attempt < SOFT_FAILURE_THRESHOLD; attempt++) {
      const result = recordFailure(records, REF, rateLimit, NOW + attempt)
      expect(result.kind).toBe('soft')
      expect(result.records[REF].blocked).toBeFalsy()
      expect(result.changed).toBe(false)
      expect(result.records[REF].occurrences).toBe(attempt)
      records = result.records
    }
    expect(blockedRefs(records)).toEqual([])
  })

  test('the third one blocks, and re-detection fires once', () => {
    let records: Record<string, FailureRecord> = {}
    for (let attempt = 1; attempt <= SOFT_FAILURE_THRESHOLD; attempt++) {
      records = recordFailure(records, REF, rateLimit, NOW + attempt).records
    }
    expect(records[REF].blocked).toBe(true)
    const again = recordFailure(records, REF, rateLimit, NOW + 99)
    expect(again.changed).toBe(false)
  })
})

describe('describeRejections', () => {
  test('lists a rejected model with the reason it was refused', () => {
    const records = recordFailure({}, REF, { message: OBSERVED_REJECTIONS[0] }, NOW).records
    const [line] = describeRejections(records)
    expect(line).toContain(`\`${REF}\``)
    expect(line).toContain('free tier can only be used from within OpenCode')
  })

  test('newest refusal first, and blocked models are left to the quarantine list', () => {
    const older = recordFailure({}, 'a/one', { message: OBSERVED_REJECTIONS[0] }, NOW).records
    const both = recordFailure(older, 'b/two', { message: OBSERVED_REJECTIONS[1] }, NOW + 500).records
    const withDead = recordFailure(both, 'c/three', { message: 'model has been deprecated' }, NOW + 900).records
    const lines = describeRejections(withDead)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('b/two')
    expect(lines[1]).toContain('a/one')
    expect(lines.join('\n')).not.toContain('c/three')
  })

  test('records written before rejections existed are not reported as rejected', () => {
    const legacy: Record<string, FailureRecord> = {
      'a/one': { ref: 'a/one', reason: 'boom', occurrences: 1, firstSeen: NOW, lastSeen: NOW }
    }
    expect(describeRejections(legacy)).toEqual([])
  })
})
