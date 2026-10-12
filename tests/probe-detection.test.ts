/**
 * Probe verdicts feeding back into detection.
 *
 * This is the loop that closes on the failure the whole investigation started
 * from: the catalog lists a refused model as `active`, detection picks it, and
 * without a probe the same dead model is re-assigned forever. The two cases
 * that must never regress:
 *
 *   1. A refused model leaves the candidate set, so the next resolve moves the
 *      role off it.
 *   2. An *unverified* model does NOT. A timeout means the probe never reached
 *      the provider, and excluding on it would discard healthy models whenever
 *      the network hiccups.
 */

import { describe, expect, test } from 'bun:test'
import { resolveRoles } from '../src/roles'
import type { ModelInfo } from '../src/types'
import { ROLES } from '../src/types'
import { model } from './fixture'

const flash = model('flash-free', 0, 0, { name: 'flash' })
const deep = model('deep-free', 0, 0, { name: 'deep' })
const CATALOG: ModelInfo[] = [flash, deep]

describe('probe refusals feeding detection', () => {
  test('an excluded model is not assigned', () => {
    const out = resolveRoles({ catalog: CATALOG, exclude: ['anthropic/flash-free'] })
    expect(out.assignments.builder?.model?.id).toBe('deep-free')
  })

  test('excluding the top model moves the role to the next one', () => {
    // The scout case: refuse everything the scorer would have picked.
    const out = resolveRoles({ catalog: CATALOG, exclude: ['anthropic/flash-free'] })
    const scoutRef = out.assignments.scout?.model
    expect(scoutRef?.id).not.toBe('flash-free')
  })

  test('excluding every model falls back to the session model', () => {
    const out = resolveRoles({
      catalog: CATALOG,
      exclude: ['anthropic/flash-free', 'anthropic/deep-free']
    })
    // No `model` key at all: the agent inherits whatever the session runs.
    for (const role of ROLES) {
      expect(out.assignments[role].source).toBe('fallback')
      expect(out.assignments[role].model).toBeUndefined()
    }
  })

  test('the all-refused fallback says so, and does not blame setup', () => {
    // "No tool-capable model available" would be wrong here: models exist, this
    // host is just refused them, and that has a different fix.
    const out = resolveRoles({
      catalog: CATALOG,
      exclude: ['anthropic/flash-free', 'anthropic/deep-free']
    })
    const reason = out.assignments.scout.reasons.join(' ')
    expect(reason).toContain('refused by the host')
    expect(reason).not.toContain('No tool-capable model available')
  })

  test('an empty catalog keeps the original setup-problem wording', () => {
    const out = resolveRoles({ catalog: [] })
    expect(out.assignments.scout.reasons.join(' ')).toContain('No tool-capable model available')
  })

  test('an empty exclusion does not claim models were refused', () => {
    const out = resolveRoles({ catalog: CATALOG, exclude: [] })
    const notes = out.notes.join(' ')
    expect(notes).not.toContain('refused by the host')
  })

  test('a pin that quarantine emptied the catalog around is honoured', () => {
    // The dead end this covers: every model excluded, so the report tells the
    // user to pin a model that answers — and the pin was then dropped by the
    // exclusion, leaving the role on the session model. The one instruction the
    // report asked for was the one instruction that could not be followed.
    const out = resolveRoles({
      catalog: CATALOG,
      overrides: { advisor: 'anthropic/flash-free' },
      exclude: ['anthropic/flash-free', 'anthropic/deep-free'],
      excludeReasons: { 'anthropic/flash-free': 'free tier can only be used' }
    })
    expect(out.assignments.advisor.model?.id).toBe('flash-free')
    expect(out.assignments.advisor.source).toBe('override')
    // Roles nothing named still inherit the session model.
    expect(out.assignments.builder.model).toBeUndefined()
    expect(out.assignments.builder.source).toBe('fallback')
  })

  test('the rescued pin says why it survived the exclusion', () => {
    const out = resolveRoles({
      catalog: CATALOG,
      overrides: { advisor: 'anthropic/flash-free' },
      exclude: ['anthropic/flash-free', 'anthropic/deep-free'],
      excludeReasons: { 'anthropic/flash-free': 'free tier can only be used' }
    })
    expect(out.notes.join(' ')).toContain('nothing else is left')
    // The exclusion is still on the record. A rescued pin that does not carry
    // its own caveat reads as a model that was never refused.
    expect(out.assignments.advisor.reasons.join(' ')).toContain('free tier can only be used')
  })

  test('a stale pin is still not side-stepped while an alternative exists', () => {
    // The rule the rescue must not break: quarantine beats a pin whenever
    // detection has somewhere else to go. Only an emptied catalog changes it.
    const out = resolveRoles({
      catalog: CATALOG,
      pins: { advisor: 'anthropic/flash-free' },
      exclude: ['anthropic/flash-free']
    })
    expect(out.assignments.advisor.source).toBe('detected')
    expect(out.assignments.advisor.model?.id).toBe('deep-free')
  })

  test('a pin this project never offered is not rescued by an emptied catalog', () => {
    // A typo is a setup problem. Rescuing it would need a model that does not
    // exist, and the exclusion is not what is wrong with it.
    const out = resolveRoles({
      catalog: CATALOG,
      overrides: { advisor: 'anthropic/ghost' },
      exclude: ['anthropic/flash-free', 'anthropic/deep-free']
    })
    expect(out.assignments.advisor.model).toBeUndefined()
    expect(out.assignments.advisor.source).toBe('fallback')
  })
})

describe('exclude reasons', () => {
  test('a refusal reason is carried into the note', () => {
    const out = resolveRoles({
      catalog: CATALOG,
      exclude: ['anthropic/flash-free'],
      excludeReasons: { 'anthropic/flash-free': 'free tier can only be used' }
    })
    const note = out.notes.join(' ')
    expect(note).toContain('free tier can only be used')
    // The ref must survive: a bare reason says nothing about which model failed,
    // and two models refused identically would be indistinguishable.
    expect(note).toContain('anthropic/flash-free')
  })

  test('two identical reasons stay distinguishable', () => {
    const many = [flash, deep, model('third-free', 0, 0, { name: 'third' })]
    const out = resolveRoles({
      catalog: many,
      exclude: ['anthropic/flash-free', 'anthropic/deep-free'],
      excludeReasons: {
        'anthropic/flash-free': 'free tier can only be used',
        'anthropic/deep-free': 'free tier can only be used'
      }
    })
    const note = out.notes.join(' ')
    expect(note).toContain('anthropic/flash-free')
    expect(note).toContain('anthropic/deep-free')
  })

  test('the ref still appears when no reason is given', () => {
    const out = resolveRoles({ catalog: CATALOG, exclude: ['anthropic/flash-free'] })
    expect(out.notes.join(' ')).toContain('anthropic/flash-free')
  })
})

describe('a refused model still does not block the others', () => {
  test('one refusal leaves the rest of the catalog working', () => {
    const out = resolveRoles({ catalog: CATALOG, exclude: ['anthropic/flash-free'] })
    expect(out.candidates.map(c => c.id)).toEqual(['deep-free'])
  })

  test('repeated calls with the same exclusion are stable', () => {
    const a = resolveRoles({ catalog: CATALOG, exclude: ['anthropic/flash-free'] })
    const b = resolveRoles({ catalog: CATALOG, exclude: ['anthropic/flash-free'] })
    expect(a.assignments).toEqual(b.assignments)
  })
})
