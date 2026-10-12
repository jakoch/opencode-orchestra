/**
 * Catalog warnings for degenerate shapes.
 *
 * Each of these has produced a confidently wrong assignment on this project, and
 * none of them is visible in the table itself — the roles look healthy while the
 * decision rests on one provider, one family, or one backend shared by two
 * roles. The shared-model warning in particular is the one per-model gate
 * needs: the gate can shed the load, but only if the collision is said out loud.
 */

import { describe, expect, test } from 'bun:test'
import plugin from '../index'
import { buildCandidates } from '../src/infer'
import type { PluginDefinitionLike } from '../src/plugin-types'
import type { ModelInfo } from '../src/types'
import { ROLES } from '../src/types'
import { model } from './fixture'
import type { PluginHarness } from './harness'
import { createPluginHarness, invocation } from './harness'

const entry = plugin as PluginDefinitionLike

async function loaded(catalog?: ModelInfo[]): Promise<PluginHarness> {
  const harness = createPluginHarness(catalog ? { models: catalog } : {})
  await entry.setup(harness.ctx)
  await harness.settle()
  return harness
}

async function report(harness: PluginHarness): Promise<string> {
  await harness.commands.get('orchestra')!.execute(invocation({ sessionID: 'ses_warn' }))
  await harness.settle()
  return harness.prompts.at(-1)?.text ?? ''
}

const FAMILY = 'llama'
const inFamily = (id: string) => model(id, 1, 2, { name: id, family: FAMILY })

describe('catalog warnings', () => {
  test('a single provider is reported', async () => {
    const harness = await loaded([inFamily('a'), inFamily('b')])
    expect(await report(harness)).toContain('one provider')
  })

  test('every candidate in one family is reported, and names the role', async () => {
    const harness = await loaded([inFamily('a'), inFamily('b')])
    const text = await report(harness)
    // One warning per role: each role's choice was forced, not chosen.
    expect(text).toMatch(/Every candidate for Builder is in the/)
    expect(text).toMatch(/Every candidate for Scout is in the/)
  })

  test('a catalog spanning families does not warn', async () => {
    const harness = await loaded([inFamily('a'), model('b', 3, 4, { name: 'b', family: 'mistral' })])
    expect(await report(harness)).not.toContain('Every candidate for')
  })

  test('no family label means no claim about families', async () => {
    // Inventing a family from a name keyword would be a coincidence dressed as
    // a fact, so an unlabelled catalog must stay silent.
    const harness = await loaded([model('a', 1, 2, { name: 'a' }), model('b', 1, 2, { name: 'b' })])
    expect(await report(harness)).not.toContain('Every candidate for')
  })

  test('a single candidate is not "every candidate in one family"', async () => {
    const harness = await loaded([inFamily('only')])
    expect(await report(harness)).not.toContain('Every candidate for')
  })

  test('two roles sharing a model are reported as contending', async () => {
    // One model in the catalog, so every role resolves to it: the shape the
    // warning exists for.
    const harness = await loaded([inFamily('solo')])
    const text = await report(harness)
    expect(text).toMatch(/share|contend/)
    expect(text).toContain('maxConcurrentPerModel')
  })

  test('distinct models produce no contention warning', async () => {
    // One model per role, deliberately varied so the resolver has a reason to
    // spread them out. Fewer is not enough: the resolver is supposed to move
    // roles off a model already in use, so with fewer models than roles it will
    // share one — and warning about that would be correct, not a false positive.
    //
    // The count comes from ROLES rather than a literal, because a hardcoded three
    // quietly became a false-positive test the moment a fourth role landed: the
    // resolver shared a model, warned, and this assertion failed for the wrong
    // reason.
    const prices = [0, 4, 12, 40, 90]
    const harness = await loaded(
      ROLES.map((_, index) => model(`tier-${index}`, prices[index] ?? 0, prices[index] ?? 0, { name: `tier-${index}` }))
    )
    const text = await report(harness)
    expect(text).not.toMatch(/contend for one backend/)
  })
})

describe('signal provenance', () => {
  // A name is not a measurement. Nothing in a catalog says `flash` is fast, so a
  // signal derived that way has to be distinguishable from a price or a limit —
  // otherwise a report can present an adjective as a result.
  const plain = model('plain-model-7', 1, 1, { name: 'plain-model-7' })
  const fast = model('model-flash-7', 1, 1, { name: 'model-flash-7' })
  const coded = model('model-coder-7', 1, 1, { name: 'model-coder-7' })

  test('an unbranded model reports nothing inferred', () => {
    const { candidates } = buildCandidates([plain])
    expect(candidates[0]!.inferredSignals).toEqual([])
  })

  test('only the signals a keyword actually moved are recorded', () => {
    const { candidates } = buildCandidates([fast])
    expect(candidates[0]!.inferredSignals).toEqual(['speed'])
  })

  test('two keywords from one name are both recorded, not merged', () => {
    // `coder` and `code` are both coding words, so they collapse to one signal.
    // A name spanning two families is the real case: each moves a different
    // score and each has to be traceable back to the keyword that moved it.
    const spanning = model('flash-coder-7', 1, 1, { name: 'flash-coder-7' })
    const { candidates } = buildCandidates([spanning])
    expect(new Set(candidates[0]!.inferredSignals)).toEqual(new Set(['speed', 'coding']))
  })

  test('two keywords in one family collapse to one signal', () => {
    // The signal is what a reason rests on, not the word that fired it.
    const { candidates } = buildCandidates([coded])
    expect(candidates[0]!.inferredSignals).toEqual(['coding'])
  })

  test('a preview family is recorded as inferred too', () => {
    const preview = model('thing-preview-7', 1, 1, { name: 'thing-preview-7' })
    const { candidates } = buildCandidates([preview])
    expect(candidates[0]!.inferredSignals).toContain('experimental')
  })
})
