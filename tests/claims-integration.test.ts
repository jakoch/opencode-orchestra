/**
 * Claims and receipts, wired into the real plugin.
 *
 * `tests/claims.test.ts` proves the tracker works and
 * `tests/receipts.test.ts` proves the store works.
 */

import { describe, expect, test } from 'bun:test'
import plugin from '../index'
import type { PluginDefinitionLike } from '../src/plugin-types'
import { mixedCatalog } from './fixture'
import type { PluginHarness } from './harness'
import { createPluginHarness, invocation } from './harness'

const entry = plugin as PluginDefinitionLike

/** The tool reads the session off its context, so every call must carry one. */
const SESSION = 'ses_claims'

async function loaded(): Promise<PluginHarness> {
  const harness = createPluginHarness({ models: mixedCatalog() })
  await entry.setup(harness.ctx)
  await harness.settle()
  return harness
}

/** A scout reply with a finding and a reference, in the envelope's shape. */
const REPLY = [
  'The fan-out gate lives in src/fanout.ts and is owned by FanoutAdmission.',
  '',
  '- FanoutAdmission admits a launch and maps it to a slot (src/fanout.ts:229).',
  '- The gate itself is per session, keyed by sessionID (src/fanout.ts:58).'
].join('\n')

describe('a delegation records claims and a receipt', () => {
  test('an answered scout call files claims the report then shows', async () => {
    const harness = await loaded()
    harness.sessionReplies['where is the fan-out gate?'] = REPLY

    await harness.callTool('orchestra_scout', { text: 'where is the fan-out gate?' }, { sessionID: SESSION })
    await harness.settle()

    await harness.commands.get('orchestra')!.execute(invocation({ sessionID: SESSION }))
    await harness.settle()

    const text = harness.prompts.at(-1)?.text ?? ''
    expect(text).toContain('Claims below are references, not copies')
    expect(text).toContain('FanoutAdmission')
  })

  test('claims never block: a scout reply with no usable line files nothing and still answers', async () => {
    const harness = await loaded()
    harness.sessionReplies['q'] = 'ok'

    const result = await harness.callTool('orchestra_scout', { text: 'q' }, { sessionID: SESSION })
    await harness.settle()

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('ok')
  })

  test('the tool reports the answer back to the builder', async () => {
    const harness = await loaded()
    harness.sessionReplies['q'] = REPLY
    const result = await harness.callTool('orchestra_scout', { text: 'q' }, { sessionID: SESSION })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('FanoutAdmission')
  })

  test('a refused delegation returns an error, not an answer', async () => {
    const harness = await loaded()
    harness.agentFailures['scout'] = 'OpenCode can only be used from within OpenCode'
    const result = await harness.callTool('orchestra_scout', { text: 'q' }, { sessionID: SESSION })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).not.toContain('FanoutAdmission')
  })
})

describe('reports carry both signals', () => {
  test('/orchestra still renders after a delegation', async () => {
    const harness = await loaded()
    harness.sessionReplies['q'] = REPLY
    await harness.callTool('orchestra_scout', { text: 'q' })
    await harness.settle()

    await harness.commands.get('orchestra')!.execute(invocation({ sessionID: SESSION }))
    await harness.settle()

    const text = harness.prompts.at(-1)?.text ?? ''
    expect(text).toContain('Orchestra')
  })
})
