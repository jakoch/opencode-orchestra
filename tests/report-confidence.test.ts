/**
 * The report must not present an unverified assignment as healthy.
 *
 * Both behaviours here exist because of one observed failure: `/orchestra`
 * printed "Scout — detected" for a model that refused every call, and the table
 * gave the operator no reason to doubt it. A detector that never fires is worse
 * than no detector, so each test below asserts the *negative* case too — that a
 * verified model does NOT get an alarming annotation.
 */

import { describe, expect, test } from 'bun:test'
import { buildCandidates } from '../src/infer'
import { renderReport } from '../src/report'
import { resolveRoles, WEIGHTS } from '../src/roles'
import { ROLES } from '../src/types'
import { model } from './fixture'

const CATALOG = [model('flash-free', 0, 0, { name: 'flash' }), model('deep-free', 0, 0, { name: 'deep' })]

function render() {
  return renderReport({
    resolved: resolveRoles({ catalog: CATALOG }),
    applied: {},
    pinPath: '.opencode/orchestra.json',
    pinStatus: 'not found, using live detection'
  })
}

describe('verification state in the report', () => {
  test('an assignment nobody has asked is marked unverified', () => {
    const text = render()
    expect(text).toContain('unverified')
  })

  test('the unverified model is named in prose, not just in the table', () => {
    // The table is glanced at once; the prose is what gets read while debugging.
    expect(render()).toContain('Not verified by request')
  })

  test('a verified model carries no alarming annotation', () => {
    const resolved = resolveRoles({ catalog: CATALOG })
    for (const role of ROLES) {
      resolved.assignments[role].verification = 'verified'
    }
    const text = renderReport({
      resolved,
      applied: {},
      pinPath: 'p',
      pinStatus: 'pinned'
    })
    expect(text).not.toContain('Not verified by request')
    expect(text).not.toContain('unverified')
    expect(text).toContain('answers')
  })

  test('a refused model says so loudly', () => {
    const resolved = resolveRoles({ catalog: CATALOG })
    resolved.assignments.scout.verification = 'refused'
    const text = renderReport({
      resolved,
      applied: {},
      pinPath: 'p',
      pinStatus: 'pinned'
    })
    expect(text).toContain('REFUSED at request time')
    expect(text).toContain('refused a real request')
  })
})

describe('degenerate catalogs are reported', () => {
  test('a signal identical for every candidate is named with its weight', () => {
    const { notes } = buildCandidates(CATALOG, WEIGHTS.scout)
    const note = notes.find(n => n.includes('cannot rank anything'))
    expect(note).toBeDefined()
    // Both models are free and neither name matches a speed keyword, so price
    // and latency are the flat signals here.
    expect(note).toContain('price')
    expect(note).toContain('scout weight')
  })

  test('a catalog that does vary is not accused of degeneracy', () => {
    // Must differ on every signal the detector inspects, or it is right to
    // accuse: these two genuinely share context, output limit, release date and
    // coding affinity, so a narrower fixture would test nothing.
    const varied = [
      model('a', 1, 1, {
        name: 'flash',
        limit: { context: 200000, output: 8192 },
        time: { released: 1700000000000 }
      }),
      model('b', 20, 20, {
        name: 'deep',
        limit: { context: 1000000, output: 64000 },
        time: { released: 1750000000000 }
      })
    ]
    const { notes } = buildCandidates(varied, WEIGHTS.scout)
    expect(notes.find(n => n.includes('cannot rank anything'))).toBeUndefined()
  })

  test('a single-model catalog makes no claim', () => {
    // "Everything is identical" is trivially true of one model and says nothing.
    const { notes } = buildCandidates([model('only', 0, 0, { name: 'only' })], WEIGHTS.scout)
    expect(notes.find(n => n.includes('cannot rank anything'))).toBeUndefined()
  })

  test('weights are optional, so buildCandidates stays callable on its own', () => {
    expect(() => buildCandidates(CATALOG)).not.toThrow()
  })
})
