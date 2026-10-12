/**
 * The harness has to be trustworthy before anything built on it means anything,
 * so the surface a test relies on — recording, firing, disposing — is checked
 * here against a stand-in plugin rather than against the real one.
 */

import { describe, expect, test } from 'bun:test'
import type { PluginContextLike } from '../src/plugin-types'
import { catalog, mixedCatalog, model } from './fixture'
import { createPluginHarness, invocation } from './harness'

/**
 * A miniature of the real plugin: registers every hook the orchestra uses and
 * talks back through `session.prompt`.
 */
async function fakePlugin(ctx: PluginContextLike, text = 'hello'): Promise<() => void> {
  await ctx.session.hook('retry', event => {
    ;(globalThis as { retried?: string }).retried = `${event.model.providerID}/${event.model.id}`
  })
  await ctx.session.hook('context', event => {
    ;(globalThis as { contextual?: string }).contextual = event.agent
  })
  await ctx.tool.hook('execute.before', () => {
    /* registration only */
  })
  await ctx.tool.hook('execute.after', () => {
    /* registration only */
  })
  await ctx.command.transform(editor => {
    editor.add({
      name: 'hello',
      execute: async input => {
        await ctx.session.prompt({ ...input.prompt, sessionID: input.sessionID, text: `${text} ${input.prompt.text}` })
      }
    })
  })
  await ctx.agent.transform(editor => {
    editor.update('builder', agent => {
      agent.system = 'configured'
    })
  })
  return () => {
    /* nothing registered, nothing to undo */
  }
}

describe('hook recording', () => {
  test('every hook lands under its own name', async () => {
    const harness = createPluginHarness()
    await fakePlugin(harness.ctx)

    expect(harness.registrations('retry')).toHaveLength(1)
    expect(harness.registrations('context')).toHaveLength(1)
    expect(harness.registrations('execute.before')).toHaveLength(1)
    expect(harness.registrations('execute.after')).toHaveLength(1)
    expect(harness.hookNames().sort()).toEqual(['context', 'execute.after', 'execute.before', 'retry'])
  })

  test('the registering surface and options are kept', async () => {
    const harness = createPluginHarness()
    await harness.ctx.session.hook(
      'retry',
      () => {
        /* registration only */
      },
      { providerID: 'anthropic' }
    )

    const [record] = harness.registrations('retry')
    expect(record?.surface).toBe('session')
    expect(record?.options).toEqual({ providerID: 'anthropic' })
    expect(harness.registrations('execute.after')[0]?.surface).toBeUndefined()
  })

  test('firing runs every live callback for that name and nothing else', async () => {
    const harness = createPluginHarness()
    const seen: string[] = []
    await harness.ctx.session.hook('retry', event => {
      seen.push(`first:${event.attempt}`)
    })
    await harness.ctx.session.hook('retry', () => {
      seen.push('second')
    })
    await harness.ctx.tool.hook('execute.before', () => {
      seen.push('tool')
    })

    await harness.fireSessionRetry({
      sessionID: 's1',
      model: { providerID: 'anthropic', id: 'm' },
      error: { type: 'ProviderError', message: 'boom' },
      attempt: 1
    })

    expect(seen).toEqual(['first:1', 'second'])
    // Both retry callbacks ran, so both firings are logged; the tool hook did not.
    expect(harness.fired.map(entry => entry.name)).toEqual(['retry', 'retry'])
    expect(harness.fired[0]?.event).toMatchObject({ sessionID: 's1', attempt: 1 })
  })

  test('an async hook is awaited, so a fire observes the settled state', async () => {
    const harness = createPluginHarness()
    const order: string[] = []
    await harness.ctx.tool.hook('execute.before', async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push('hook')
    })

    await harness.fireToolBefore({ tool: 'subagent', input: {}, status: 'completed', sessionID: 's1' })

    expect(order).toEqual(['hook'])
  })

  test('disposed registrations stop firing', async () => {
    const harness = createPluginHarness()
    let calls = 0
    const registration = await harness.ctx.tool.hook('execute.after', () => {
      calls += 1
    })

    await harness.fireToolAfter({ tool: 'edit', input: {}, status: 'completed', sessionID: 's1' })
    await registration.dispose()
    await harness.fireToolAfter({ tool: 'edit', input: {}, status: 'completed', sessionID: 's1' })

    expect(calls).toBe(1)
    expect(harness.registrations('execute.after')).toHaveLength(0)
  })

  test('disposeAll clears hooks and transforms together', async () => {
    const harness = createPluginHarness()
    await fakePlugin(harness.ctx)

    await harness.disposeAll()

    expect(harness.registrations('retry')).toHaveLength(0)
    expect(harness.registrations('execute.after')).toHaveLength(0)
    expect(harness.transforms.every(record => record.disposed)).toBe(true)
  })
})

describe('prompt recording', () => {
  test('prompt text, session and delivery are captured', async () => {
    const harness = createPluginHarness()
    await harness.ctx.session.prompt({
      sessionID: 's1',
      text: '## Orchestra',
      delivery: 'queue'
    })

    expect(harness.prompts).toEqual([{ sessionID: 's1', text: '## Orchestra', delivery: 'queue' }])
    expect(harness.promptTexts()).toEqual(['## Orchestra'])
    expect(harness.lastPrompt()?.text).toBe('## Orchestra')
    expect(harness.calls).toContain('session.prompt')
  })

  test('lastPrompt is undefined until the plugin speaks', () => {
    expect(createPluginHarness().lastPrompt()).toBeUndefined()
  })

  test('runCommand executes a registered command with an invocation', async () => {
    const harness = createPluginHarness()
    await fakePlugin(harness.ctx, 'report:')

    await harness.runCommand('hello', invocation({ sessionID: 's7', prompt: { text: 'all' } }))

    expect(harness.lastPrompt()).toMatchObject({ sessionID: 's7', text: 'report: all' })
  })

  test('runCommand names what is registered when the command is missing', async () => {
    const harness = createPluginHarness()
    await fakePlugin(harness.ctx)

    await expect(harness.runCommand('nope')).rejects.toThrow(/no command registered as "nope".*hello/)
  })
})

describe('editor surfaces', () => {
  test('agent update creates a missing agent and keeps the id', async () => {
    const harness = createPluginHarness()
    await harness.ctx.agent.transform(editor => {
      expect(editor.get('builder')).toBeUndefined()
      editor.update('builder', agent => {
        agent.name = 'Builder'
        agent.model = { providerID: 'anthropic', id: 'opus' }
      })
    })

    expect(harness.agent('builder')).toMatchObject({
      id: 'builder',
      name: 'Builder',
      model: { providerID: 'anthropic', id: 'opus' }
    })
  })

  test('an agent model without an id is refused, the way the host refuses it', async () => {
    // The harness encodes the host's decode, so a regression that writes the
    // config shape (`{providerID, model}`) fails here instead of silently
    // producing an agent list that `/api/agent` cannot serialize.
    const harness = createPluginHarness()
    await expect(
      harness.ctx.agent.transform(editor => {
        editor.update('builder', agent => {
          // @ts-expect-error — deliberately wrong: the config shape, not `Model.Ref`.
          agent.model = { providerID: 'anthropic', model: 'opus' }
        })
      })
    ).rejects.toThrow(/model without an id/)
  })

  test('agent default is settable, and is reverted on dispose', async () => {
    const harness = createPluginHarness({ agents: [{ id: 'custom', name: 'Custom' }] })
    const registration = await harness.ctx.agent.transform(editor => {
      editor.default('builder')
    })

    expect(harness.defaultAgent()).toBe('builder')

    await registration.dispose()

    expect(harness.defaultAgent()).toBeUndefined()
    expect(harness.agents.has('builder')).toBe(false)
    expect(harness.agent('custom')?.name).toBe('Custom')
  })

  test('an existing agent is updated in place rather than replaced', async () => {
    const harness = createPluginHarness({
      agents: [{ id: 'builder', name: 'Mine', system: 'keep me' }]
    })
    await harness.ctx.agent.transform(editor => {
      editor.update('builder', agent => {
        agent.model = { providerID: 'openai', id: 'gpt-5.2' }
      })
    })

    expect(harness.agent('builder')).toMatchObject({
      name: 'Mine',
      system: 'keep me',
      model: { providerID: 'openai', id: 'gpt-5.2' }
    })
  })

  test('the model editor round-trips the session default', async () => {
    const harness = createPluginHarness({ models: mixedCatalog() })
    await harness.ctx.model.transform(editor => {
      expect(editor.default.get()).toBeUndefined()
      editor.default.set('openai', 'gpt-5.2')
    })

    expect(harness.modelDefault()).toEqual({ providerID: 'openai', modelID: 'gpt-5.2' })
    expect(harness.ctx.model.default().then(result => result.data?.id)).resolves.toBe('gpt-5.2')
  })

  test('the model editor lists by provider and is reverted on dispose', async () => {
    const harness = createPluginHarness({ models: mixedCatalog() })
    const registration = await harness.ctx.model.transform(editor => {
      expect(editor.list('ollama').map(entry => entry.id)).toEqual(['qwen3-coder:30b'])
      editor.default.set('anthropic', 'claude-opus-4-1')
    })

    await registration.dispose()

    expect(harness.modelDefault()).toBeUndefined()
  })

  test('a command transform removes only what it added when disposed', async () => {
    const harness = createPluginHarness({ commands: [{ name: 'builtin' }] })
    // `command.transform` is typed as returning `Promise<unknown>` — the host
    // does not promise a disposer there — so the recorded registration is the
    // only handle a test has.
    harness.ctx.command.transform(editor => {
      editor.add({
        name: 'orchestra',
        execute: async () => {
          /* the harness records the command; it never runs it */
        }
      })
    })
    expect(harness.commands.has('orchestra')).toBe(true)

    await harness.transforms.at(-1)?.dispose()

    expect(harness.commands.has('orchestra')).toBe(false)
    expect(await harness.ctx.command.list().then(result => result.data?.map(entry => entry.name))).toEqual(['builtin'])
  })

  test('re-registering a transform does not pile up agents', async () => {
    const harness = createPluginHarness()
    await harness.ctx.agent.transform(editor => {
      editor.update('builder', agent => {
        agent.system = 'first'
      })
    })
    await harness.transforms.at(-1)?.dispose()

    await harness.ctx.agent.transform(editor => {
      editor.update('builder', agent => {
        agent.system = 'second'
      })
    })

    expect(harness.agents.size).toBe(1)
    expect(harness.agent('builder')?.system).toBe('second')
    expect(harness.transforms.map(record => record.index)).toEqual([0, 1])
  })
})

describe('catalog and storage', () => {
  test('setCatalog swaps what the next model.list sees', async () => {
    const harness = createPluginHarness({ models: catalog(model('a', 1, 1)) })

    harness.setCatalog(catalog(model('b', 2, 2)))

    expect(await harness.ctx.model.list().then(result => result.data.map(entry => entry.id))).toEqual(['b'])
  })

  test('storage round-trips and records every key', async () => {
    const harness = createPluginHarness({ storage: { quarantine: { 'anthropic/opus': { ref: 'anthropic/opus' } } } })

    expect(await harness.ctx.storage.get('quarantine')).toMatchObject({ 'anthropic/opus': { ref: 'anthropic/opus' } })
    await harness.ctx.storage.set('other', 1)
    await harness.ctx.storage.remove('quarantine')

    expect(harness.store.has('quarantine')).toBe(false)
    expect(harness.calls.filter(entry => entry.startsWith('storage.'))).toEqual([
      'storage.get:quarantine',
      'storage.set:other',
      'storage.remove:quarantine'
    ])
  })

  test('session.context serves the configured transcript', async () => {
    const harness = createPluginHarness()
    harness.setSessionMessages([{ tokens: { input: 10, output: 2 } }])

    expect(await harness.ctx.session.context({ sessionID: 's1' })).toEqual([{ tokens: { input: 10, output: 2 } }])
  })
})
