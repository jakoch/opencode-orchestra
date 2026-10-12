/**
 * A probe result re-roling the live plugin.
 *
 * The unit tests prove the resolver honours `exclude`. This proves the probe
 * result reaches the resolver at all — through the command, into the registry,
 * with the model actually changing. A feedback loop that is wired up but does
 * not fire is indistinguishable, from the outside, from no loop at all.
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

async function probe(harness: PluginHarness) {
  await harness.commands.get('orchestra-probe')!.execute({ sessionID: 'ses_1', prompt: { text: '' } })
  await harness.settle()
  return harness.prompts.at(-1)?.text ?? ''
}

describe('probe re-roles the plugin', () => {
  test('a model refused by both routes moves the role off it', async () => {
    const harness = await loaded()
    const before = harness.agents.get('builder')?.model?.id

    // Refuse whichever model the resolver picked, on both routes. A refusal from
    // `generate` alone is not enough: the session route gets a second opinion,
    // because that refusal may be about the caller rather than the model.
    const picked = harness.agents.get('builder')?.model
    const ref = `${picked!.providerID}/${picked!.id}`
    harness.generateFailures[ref] = "OpenCode's free tier can only be used from within OpenCode"
    harness.sessionFailures[ref] = "OpenCode's free tier can only be used from within OpenCode"

    await probe(harness)

    expect(harness.agents.get('builder')?.model?.id).not.toBe(before)
    expect(harness.agents.get('builder')?.model?.id).toBeDefined()
  })

  test('the user is told detection was corrected', async () => {
    const harness = await loaded()
    const picked = harness.agents.get('builder')?.model
    const ref = `${picked!.providerID}/${picked!.id}`
    harness.generateFailures[ref] = 'free tier can only be used'
    harness.sessionFailures[ref] = 'free tier can only be used'

    const text = await probe(harness)
    expect(text).toContain('Re-detected without 1 refused model')
  })

  test('a model refused only by generate is retried over a session', async () => {
    // The bug this whole fallback exists for: `generate` runs without a session
    // and the free tier refuses it, so a perfectly good model would be dropped
    // on the word of a route that was never allowed to reach it.
    const harness = await loaded()
    const before = harness.agents.get('builder')?.model?.id
    const picked = harness.agents.get('builder')?.model
    harness.generateFailures[`${picked!.providerID}/${picked!.id}`] = 'free tier can only be used'

    await probe(harness)

    expect(harness.agents.get('builder')?.model?.id).toBe(before)
    expect(harness.prompts.at(-1)?.text).toContain('Every assigned model answered')
  })

  test('an all-healthy probe changes nothing', async () => {
    const harness = await loaded()
    const before = harness.agents.get('builder')?.model?.id
    await probe(harness)
    expect(harness.agents.get('builder')?.model?.id).toBe(before)
    expect(await probe(harness)).toContain('Every assigned model answered.')
  })

  test('an unreachable probe does not re-role anything', async () => {
    // A timeout is not evidence about the model. If this re-roled, a flaky
    // network would silently change which models the project uses.
    const harness = await loaded({ probeTimeoutMs: 30 })
    const before = harness.agents.get('builder')?.model?.id

    // A probe that never resolves. `probeAssignments` bounds this with the
    // configured timeout, so the command returns `unverified` rather than hanging.
    harness.ctx.generate = {
      text: () =>
        new Promise(() => {
          /* never settles: this is the timeout path */
        })
    } as typeof harness.ctx.generate

    await probe(harness)
    expect(harness.agents.get('builder')?.model?.id).toBe(before)
  })

  test('a slow model is never dropped from detection', async () => {
    // The bug this covers: a model answering in 13s threw a timeout-shaped
    // error, which was classified `refused`, which removed it from the
    // candidate set — so scout silently lost its model and nobody knew why.
    const harness = await loaded({ probeTimeoutMs: 50 })
    const before = harness.agents.get('builder')?.model?.id
    const picked = harness.agents.get('builder')?.model
    harness.generateFailures[`${picked!.providerID}/${picked!.id}`] = 'request timed out after 13000ms'

    await probe(harness)

    expect(harness.agents.get('builder')?.model?.id).toBe(before)
    const text = harness.prompts.at(-1)?.text ?? ''
    expect(text).not.toContain('Refused:')
  })

  test('a rate-limited model is never dropped from detection', async () => {
    const harness = await loaded()
    const before = harness.agents.get('builder')?.model?.id
    const picked = harness.agents.get('builder')?.model
    harness.generateFailures[`${picked!.providerID}/${picked!.id}`] = '429 Too Many Requests'

    await probe(harness)

    expect(harness.agents.get('builder')?.model?.id).toBe(before)
  })

  test('a probe does not write the durable failure store', async () => {
    const harness = await loaded()
    const picked = harness.agents.get('builder')?.model
    harness.generateFailures[`${picked!.providerID}/${picked!.id}`] = 'free tier can only be used'
    await probe(harness)

    const stored = JSON.stringify(harness.store.get('quarantine') ?? null)
    expect(stored).not.toContain(picked!.id)
  })
})
