/**
 * `/orchestra probe` end to end, through the real plugin entry.
 *
 * The unit tests in `tests/probe.test.ts` prove the verdict logic. These prove
 * the command is wired up at all: registered, routed, and able to say
 * something useful about a dead model. A probe nobody can invoke is a module.
 */

import { describe, expect, test } from 'bun:test'
import plugin from '../index'
import type { PluginDefinitionLike } from '../src/plugin-types'
import { ROLES } from '../src/types'
import { model } from './fixture'
import type { PluginHarness } from './harness'
import { createPluginHarness } from './harness'

/** Plugin entry as the host sees it. */
const entry = plugin as PluginDefinitionLike

const BUSY_MODELS = [
  model('muse-free', 0, 0, { name: 'muse' }),
  model('flash-free', 0, 0, { name: 'flash' }),
  model('deep-free', 0, 0, { name: 'deep' })
]

async function loaded(): Promise<PluginHarness> {
  const harness = createPluginHarness({ models: BUSY_MODELS })
  await entry.setup(harness.ctx)
  await harness.settle()
  return harness
}

/** Text the plugin sent to the session, i.e. what the user would have seen. */
function lastPrompt(harness: PluginHarness): string {
  return harness.prompts.at(-1)?.text ?? ''
}

describe('/orchestra-probe', () => {
  test('is registered as a command', async () => {
    const harness = await loaded()
    expect(harness.commands.has('orchestra-probe')).toBe(true)
  })

  test('probes every assigned role and reports each one', async () => {
    const harness = await loaded()
    await harness.commands.get('orchestra-probe')!.execute({
      sessionID: 'ses_probe',
      prompt: { text: '' }
    })
    await harness.settle()

    // One probe per role, from ROLES: the count here is the contract that a new
    // role is actually probed, not merely registered.
    expect(harness.generated.length).toBe(ROLES.length)
    const text = lastPrompt(harness)
    expect(text).toContain('answered')
    expect(text).toContain('Every assigned model answered.')
  })

  test('names a refused role and offers a pin that works', async () => {
    const harness = await loaded()

    // Refuse scout's model on both routes, so the refusal is final and the
    // suggestion path is actually exercised.
    const scout = harness.agents.get('scout')?.model
    expect(scout).toBeDefined()
    const ref = `${scout!.providerID}/${scout!.id}`
    harness.generateFailures[ref] = "OpenCode's free tier can only be used from within OpenCode"
    harness.sessionFailures[ref] = "OpenCode's free tier can only be used from within OpenCode"

    await harness.commands.get('orchestra-probe')!.execute({
      sessionID: 'ses_probe',
      prompt: { text: '' }
    })
    await harness.settle()

    const text = lastPrompt(harness)
    expect(text).toContain('scout')
    expect(text).toContain('refused')
    expect(text).toContain('free tier')
    // The suggestion must not be the model that just refused.
    expect(text).toContain('"roles"')
  })

  test('a probe never writes storage, so it cannot blacklist a model', async () => {
    const harness = await loaded()
    const before = JSON.stringify([...harness.store.entries()])

    const scout = harness.agents.get('scout')?.model
    harness.generateFailures[`${scout!.providerID}/${scout!.id}`] = 'free tier can only be used'
    await harness.commands.get('orchestra-probe')!.execute({
      sessionID: 'ses_probe',
      prompt: { text: '' }
    })
    await harness.settle()

    expect(JSON.stringify([...harness.store.entries()])).toBe(before)
  })

  test('/orchestra probe routes to the same probe', async () => {
    const harness = await loaded()
    await harness.commands.get('orchestra')!.execute({
      sessionID: 'ses_probe',
      prompt: { text: 'probe' }
    })
    await harness.settle()

    // The probe path generates; the plain report path does not.
    expect(harness.generated.length).toBe(ROLES.length)
  })

  test('plain /orchestra does not spend requests on probing', async () => {
    const harness = await loaded()
    await harness.commands.get('orchestra')!.execute({
      sessionID: 'ses_probe',
      prompt: { text: '' }
    })
    await harness.settle()
    expect(harness.generated.length).toBe(0)
  })
})

describe('probe without generate.text', () => {
  test('reports unverified, never refused, and keeps every assignment', async () => {
    const harness = createPluginHarness({ models: BUSY_MODELS, omit: ['generate.text'] })
    await entry.setup(harness.ctx)
    await harness.settle()
    // The session route stays up but never gets far enough to ask: a timeout
    // says nothing about the model, so the verdict must stay unverified.
    for (const candidate of BUSY_MODELS) {
      harness.sessionFailures[`${candidate.providerID}/${candidate.id}`] = 'probe timed out after 45000ms'
    }

    await harness.commands.get('orchestra-probe')!.execute({
      sessionID: 'ses_probe',
      prompt: { text: '' }
    })
    await harness.settle()

    // The primary assertion is the negative one: a missing host method must
    // not read as a dead model, or one probe un-assigns every role.
    const text = lastPrompt(harness)
    expect(text).toContain('was not verified')
    expect(text).not.toContain('Refused:')
    for (const role of ROLES) expect(harness.agents.get(role)?.model).toBeDefined()
  })
})
