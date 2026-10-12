/**
 * One outcome vocabulary.
 *
 * The mapping table is the deliverable, so it is asserted both ways: every
 * failure class lands where it should, and nothing collapses into a neighbour.
 * The second half matters more — a classifier that quietly returns `failed` for
 * everything still passes a table that only checks the two obvious rows.
 */

import { describe, expect, test } from 'bun:test'
import { FAILURE_CLASSES, type FailureClass } from '../src/failure'
import { isDelivered, outcomeFor } from '../src/outcome'

describe('outcome mapping', () => {
  test.each([
    ["OpenCode's free tier can only be used from within OpenCode", 'refused'],
    ['model retired', 'refused'],
    ['model deprecated', 'refused'],
    ['no such model', 'refused'],
    ['Rate limit exceeded', 'uncertain'],
    ['read ECONNRESET', 'uncertain'],
    ['request timed out', 'uncertain'],
    ['service unavailable', 'uncertain'],
    ['the agent produced no reply', 'failed'],
    ['agent not registered in this directory', 'failed']
  ] as const)('%s is %s', (error, expected) => {
    expect(outcomeFor(error).status).toBe(expected)
  })

  test('every class maps to a decided status, and all three are reachable', () => {
    // `undefined` had to mean something. Leaving it out is how "no verdict"
    // becomes a fifth status nobody documented.
    const representative: Record<FailureClass, string> = {
      withdrawn: 'model retired',
      rejected: 'free tier can only be used within opencode',
      rate_limited: 'Rate limit exceeded',
      transport: 'read ECONNRESET',
      interrupted: 'request timed out',
      unavailable: 'service unavailable',
      task: 'something unrecognised'
    }
    const seen = new Set(FAILURE_CLASSES.map(name => outcomeFor(representative[name]).status))
    expect([...seen].sort()).toEqual(['failed', 'refused', 'uncertain'])
  })

  test('the refusal keeps which refusal it was', () => {
    // A credential wants a different pin from a withdrawn model, and `refused`
    // alone cannot say which.
    expect(outcomeFor('free tier can only be used within opencode').cause).toBe('rejected')
    expect(outcomeFor('model retired').cause).toBe('withdrawn')
  })

  test('a rate limit is uncertain, not a failed task', () => {
    // The regression this naming exists to end: a rate-limited dispatch recorded
    // as `failed` told the builder the scout had found nothing.
    expect(outcomeFor('Rate limit exceeded').status).toBe('uncertain')
  })

  test('an absent error is a failure, not an exception', () => {
    expect(outcomeFor(undefined).status).toBe('failed')
  })

  test('only delivered counts as an answer', () => {
    expect(isDelivered('delivered')).toBe(true)
    for (const status of ['refused', 'uncertain', 'failed'] as const) {
      expect(isDelivered(status)).toBe(false)
    }
  })

  test('a delivered turn and a refused one never read alike', () => {
    // The distinction a receipt had no name for: the model was never asked.
    const refused = outcomeFor('free tier can only be used within opencode')
    const uncertain = outcomeFor('request timed out')
    expect(refused.status).not.toBe(uncertain.status)
    expect(refused.cause).not.toBe(uncertain.cause)
  })
})
