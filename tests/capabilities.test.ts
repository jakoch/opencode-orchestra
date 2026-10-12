/**
 * Capability probing and the session adapter.
 *
 * Pure where possible: the table, the tripwire against scope creep, and the
 * adapter's reject-instead-of-TypeError contract. Host-shaped behavior (a
 * reduced host still loading, a missing `remove` still delivering) lives in
 * `tests/plugin.test.ts`, which drives the real entry point.
 */
import { describe, expect, test } from 'bun:test'
import { detectCapabilities, memoryStorage, NEVER_CALLED, PATHS, sessionAdapter } from '../src/capabilities'
import { mixedCatalog } from './fixture'
import { createPluginHarness } from './harness'

describe('capability probing', () => {
  test('a full mirror reports nothing missing', () => {
    // Guards against a typo in PATHS making every degrade path fire at once.
    const created = createPluginHarness({ models: mixedCatalog() })
    expect(detectCapabilities(created.ctx).missing()).toEqual([])
  })

  test('deleting exactly one member yields exactly that name', () => {
    // Asserted on the `missing()` array (not `has`) so a probe that drops two
    // at once fails here instead of passing somewhere weaker.
    const created = createPluginHarness({ models: mixedCatalog(), omit: ['generate.text'] })
    expect(detectCapabilities(created.ctx).missing()).toEqual(['generate.text'])
  })

  test("the table's intersection with the never-called list is empty", () => {
    // Tripwire: probing a member nothing calls would create code that exists
    // only to fail, so the table must not grow to include one.
    const probed = new Set(Object.keys(PATHS))
    expect(NEVER_CALLED.filter(name => probed.has(name))).toEqual([])
  })

  test('the adapter rejects naming the capability', async () => {
    const created = createPluginHarness({ models: mixedCatalog(), omit: ['session.remove'] })
    const caps = detectCapabilities(created.ctx)
    const adapter = sessionAdapter(created.ctx, caps)
    await expect(adapter.remove({ sessionID: 'ses_x' })).rejects.toThrow('missing capability: session.remove')
    // ...while a present member passes straight through.
    const session = await adapter.create({ title: 't' })
    expect(session.id.startsWith('ses_')).toBe(true)
  })

  test('memory storage keeps and drops keys', async () => {
    const storage = memoryStorage()
    expect(await storage.get('k')).toBeUndefined()
    await storage.set('k', { n: 1 })
    expect(await storage.get('k')).toEqual({ n: 1 })
    await storage.remove('k')
    expect(await storage.get('k')).toBeUndefined()
  })
})
