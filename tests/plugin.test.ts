/**
 * The plugin driven through the mock context.
 *
 * `src/selftest.ts` covers the pure modules. What it cannot reach is the wiring
 * in `plugin/index.ts`: which hooks get registered, what lands in the agent
 * registry, and what the slash commands actually say. Those are exactly the
 * parts that need a host, and the harness is the host.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import plugin from '../index'
import type { PluginDefinitionLike, ToolHookEventLike } from '../src/plugin-types'
import { ROLES } from '../src/types'
import { PLUGIN_VERSION } from '../src/version'
import { mixedCatalog, visionOnlyModel } from './fixture'
import type { PluginHarness, PluginHarnessOptions } from './harness'
import { createPluginHarness, invocation } from './harness'

/** Plugin entry as the host sees it. */
const entry = plugin as PluginDefinitionLike

/**
 * A tool event as the fan-out gate receives it.
 *
 * `plugin/index.ts` correlates a host tool-call id with its slot and casts the
 * event to reach it, but `ToolHookEventLike` does not declare `id`. Tests drive
 * that path, so they state the id explicitly and the intersection records the
 * gap instead of hiding it behind a cast.
 */
type ToolCallEvent = ToolHookEventLike & { id?: string }

let harness: PluginHarness | undefined
let teardown: undefined | (() => void)

async function load(
  options: PluginHarnessOptions = {},
  pluginOptions: Record<string, unknown> = {}
): Promise<PluginHarness> {
  const created = createPluginHarness({ models: mixedCatalog(), options: pluginOptions, ...options })
  harness = created
  teardown = await entry.setup(created.ctx)
  return created
}

afterEach(async () => {
  // `setup` returns `void` when the plugin loads inert, so the teardown handle
  // is optional in practice even though the type is not.
  if (typeof teardown === 'function') await teardown()
  await harness?.disposeAll()
  teardown = undefined
  harness = undefined
})

describe('plugin entry', () => {
  test('exports the shape OpenCode loads', () => {
    expect(typeof entry.id).toBe('string')
    expect(typeof entry.setup).toBe('function')
  })
})

describe('setup', () => {
  test('an inert plugin registers nothing', async () => {
    const created = await load({}, { enabled: false })

    expect(created.hookNames()).toEqual([])
    expect([...created.commands.keys()]).toEqual([])
    expect(created.agents.size).toBe(0)
  })

  test('registers one agent per role, pointed at the detected model', async () => {
    const created = await load()

    for (const role of ROLES) {
      const agent = created.agent(role)
      expect(agent).toBeDefined()
      expect(agent?.name).toBeTruthy()
      // Detection is the point: an assignment must carry a real provider/model.
      expect(agent?.model?.providerID).toBeTruthy()
      expect(agent?.model?.id).toBeTruthy()
    }
    expect(created.agent('scout')?.mode).toBe('subagent')
  })

  test('an agent carries its model in the host registry shape, with an id', async () => {
    // The blocker, found by running the plugin against a real host rather than
    // by reading the SDK types: `AgentEditor.update` hands its callback a
    // resolved `Agent.Info`, and the host encodes that on the way out. Writing
    // the *config* shape there — `{providerID, model, variant}`, which is what
    // `opencode.jsonc` uses — leaves the registry with a model that has no `id`,
    // and the agent list then fails to encode as a whole:
    //
    //   GET /api/agent -> 400
    //   Missing key at ["data"][0]["model"]["id"]
    //
    // which takes the chat dialog's agent *and* model selector down with it, so
    // a fresh session opens with nothing selected.
    //
    // Asserting the absent key as well as the present one is the point:
    // `toMatchObject` on `model` alone would still pass if someone wrote both.
    const created = await load({}, { roles: { advisor: 'openai/gpt-5.2' } })

    const model = created.agent('advisor')?.model
    expect(model).toMatchObject({ id: 'gpt-5.2', providerID: 'openai' })
    expect(model).not.toHaveProperty('model')
  })

  test("leaves a project-defined agent's prompt alone and only retargets the model", async () => {
    const created = await load({ agents: [{ id: 'builder', name: 'Mine', system: 'my prompt', mode: 'primary' }] })

    expect(created.agent('builder')).toMatchObject({
      name: 'Mine',
      system: 'my prompt',
      model: created.agent('builder')?.model
    })
    expect(created.agent('builder')?.model).toBeDefined()
  })

  test('registers the hooks the runtime features are built on', async () => {
    const created = await load()

    for (const name of ['retry', 'context', 'execute.before', 'execute.after'] as const) {
      expect(created.registrations(name).length).toBeGreaterThan(0)
    }
  })

  test('reads the persisted quarantine on load', async () => {
    const created = await load()

    expect(created.calls).toContain('storage.get:quarantine')
  })

  test('an empty catalog yields no model rather than a crash', async () => {
    const created = await load({ models: [visionOnlyModel()] })

    expect(created.agent('builder')?.model).toBeUndefined()
  })

  test('the plugin option override wins over detection', async () => {
    const created = await load({}, { roles: { advisor: 'openai/gpt-5.2' } })

    expect(created.agent('advisor')?.model).toMatchObject({ id: 'gpt-5.2', providerID: 'openai' })
  })
})

describe('commands', () => {
  test('/orchestra is registered and reports the assignment', async () => {
    const created = await load()

    expect([...created.commands.keys()]).toEqual(expect.arrayContaining(['orchestra', 'orchestra-pin', 'checkpoint']))
    await created.runCommand('orchestra', invocation())

    const text = created.lastPrompt()?.text ?? ''
    expect(text).toContain('Orchestra:')
    expect(text).toContain('Builder')
    expect(text).toContain('Advisor')
    // The report has to name the model, not just the role, or it explains nothing.
    const builder = created.agent('builder')?.model
    expect(text).toContain(`${builder?.providerID}/${builder?.id}`)
  })

  test('/orchestra verbose appends the candidate table', async () => {
    const created = await load()
    await created.runCommand('orchestra', invocation({ prompt: { text: 'all' } }))

    expect(created.lastPrompt()?.text).toContain('All candidates')
  })

  test('a compaction reaches the diagnostics, and a barren one still shows', async () => {
    // The wiring, not the counter: `recordCompaction` is unit-tested, and what
    // this catches is the hook quietly ceasing to call it — which would leave
    // "are receipts ever lost to compaction?" permanently unanswerable while
    // every test stayed green.
    const created = await load()
    await created.runCommand('orchestra', invocation({ prompt: { text: 'all' } }))
    await created.settle()

    // Nothing consumed yet, so this compaction re-opens nothing — the zero that
    // would be invisible if only successes were counted.
    await created.fire('compaction', { sessionID: 's1' })
    await created.settle()
    await created.runCommand('orchestra', invocation({ prompt: { text: 'all' } }))
    await created.settle()

    expect(created.lastPrompt()?.text).toContain('across 1 compaction(s)')
  })

  test('/orchestra version answers with the version, not the table', async () => {
    const created = await load()
    await created.runCommand('orchestra', invocation({ prompt: { text: 'version' } }))

    const text = created.lastPrompt()?.text ?? ''
    expect(text).toContain(`opencode-orchestra ${PLUGIN_VERSION}`)
    // A diagnostics answer must not drag the assignment table along with it.
    expect(text).not.toContain('| Role | Model | Chosen by |')
  })

  test('/orchestra carries the version line in the full report', async () => {
    const created = await load()
    await created.runCommand('orchestra', invocation())

    expect(created.lastPrompt()?.text).toContain(`Plugin version: \`${PLUGIN_VERSION}\``)
  })

  test('/checkpoint relays the advisor contract', async () => {
    const created = await load()
    await created.runCommand('checkpoint', invocation())

    const text = created.lastPrompt()?.text ?? ''
    expect(text).toContain('advisor checkpoint')
    expect(text).toContain('advisor')
  })

  test('/orchestra-pin is refused when pinning is disabled', async () => {
    const created = await load({}, { pin: false })
    await created.runCommand('orchestra-pin', invocation())

    expect(created.lastPrompt()?.text).toContain('Pinning is disabled')
  })

  test('commands can be turned off without losing the agents', async () => {
    const created = await load({}, { commands: false })

    expect([...created.commands.keys()]).toEqual([])
    expect(created.agent('builder')).toBeDefined()
  })

  test('defaultModel points the session default at the builder', async () => {
    const created = await load({}, { defaultModel: true })
    const builder = created.agent('builder')?.model
    // The builder must have a model for this assertion to mean anything, and the
    // real API takes strings — asserting against `undefined` would compare a
    // value the host could never hold.
    expect(builder).toBeDefined()
    expect(created.modelDefault()).toEqual({
      providerID: builder!.providerID,
      modelID: builder!.id
    })
  })
})

describe('retry hook', () => {
  test('a terminal provider failure is quarantined and re-detected around', async () => {
    const created = await load()
    const held = created.agent('advisor')?.model
    expect(held).toBeDefined()

    await created.fireSessionRetry({
      sessionID: 's1',
      model: { providerID: held!.providerID, id: held!.id },
      error: { type: 'ProviderError', message: 'no such model' },
      attempt: 1
    })
    await created.settle()

    expect(created.store.get('quarantine')).toBeDefined()
    // The model that just failed must not still be holding the role.
    expect(created.agent('advisor')?.model).not.toMatchObject({ id: held!.id, providerID: held!.providerID })
  })

  test('a failure that says nothing about the model is not remembered', async () => {
    const created = await load()
    await created.fireSessionRetry({
      sessionID: 's1',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
      error: { type: 'UnknownError', message: 'something went sideways' },
      attempt: 1
    })
    await created.settle()

    expect(created.store.get('quarantine')).toBeUndefined()
  })
})

describe('fan-out gate', () => {
  const subagentCall = (id: string): ToolCallEvent => ({
    id,
    sessionID: 's1',
    tool: 'subagent',
    input: { agent: 'scout' },
    status: 'completed'
  })

  test('a launch over the limit is refused with an explanation, not hung', async () => {
    const created = await load({}, { maxConcurrentSubagents: 1, fanoutWaitMs: 50 })

    await created.fireToolBefore(subagentCall('call-1'))
    await expect(created.fireToolBefore(subagentCall('call-2'))).rejects.toThrow(/orchestra/)

    // Releasing the slot lets the next launch through, which is what proves the
    // refusal was a full gate rather than a permanently broken one.
    await created.fireToolAfter(subagentCall('call-1'))
    await created.fireToolBefore(subagentCall('call-3'))
  })

  test('a zero limit disables the gate entirely', async () => {
    const created = await load({}, { maxConcurrentSubagents: 0 })

    // The only remaining `execute.before` registration is the loop-guard refusal,
    // which is deliberately not tied to the fan-out knob. So the gate is
    // asserted behaviourally: two identical launches must both get through
    // without a refusal, rather than by counting hooks.
    await created.fireToolBefore(subagentCall('call-1'))
    await created.fireToolBefore(subagentCall('call-2'))
  })

  test('a non-subagent tool is never gated', async () => {
    const created = await load({}, { maxConcurrentSubagents: 1, fanoutWaitMs: 50 })

    await created.fireToolBefore({ sessionID: 's1', tool: 'edit', input: {}, status: 'completed' })
    await created.fireToolBefore({
      sessionID: 's1',
      tool: 'custom_subagent',
      input: { agent: 'scout' },
      status: 'completed'
    })
  })
})

describe('tool hook', () => {
  test('a write is recorded as unverified evidence', async () => {
    const created = await load()
    await created.fireToolAfter({
      sessionID: 's1',
      tool: 'edit',
      input: { filePath: '/repo/a.ts' },
      status: 'completed'
    })

    await created.runCommand('checkpoint', invocation({ sessionID: 's1' }))

    expect(created.lastPrompt()?.text).toContain('/repo/a.ts')
  })
})

describe('reduced host', () => {
  test('load survives without storage, generate.text or session.context', async () => {
    const created = await load({ omit: ['storage.get', 'storage.set', 'generate.text', 'session.context'] })
    // "Did not throw" would also pass for a plugin that silently did nothing.
    expect(created.agents.size).toBeGreaterThan(0)
    // And the degradation must reach the report — one the user cannot see is
    // the bug this whole work package exists to end.
    await created.runCommand('orchestra', invocation({ sessionID: 's1' }))
    const text = created.lastPrompt()?.text ?? ''
    expect(text).toContain('process-local')
    expect(text).toContain('no usage is read')
  })

  test('missing tool.transform loads without delegation tools, and says so', async () => {
    const created = await load({ omit: ['tool.transform'] })
    expect(created.agents.size).toBeGreaterThan(0)
    expect(created.registeredTools.has('orchestra_scout')).toBe(false)
    await created.runCommand('orchestra', invocation({ sessionID: 's1' }))
    expect(created.lastPrompt()?.text ?? '').toContain('no orchestra_* tools are registered')
  })

  test('minimal mode does not register the reviewer tools', async () => {
    // The structural claim, checked where it is actually decided. A mode that
    // only rewrote the prompt would pass every prompt assertion and still leave
    // `orchestra_advisor` callable — a cost control the model can decline.
    const created = await load({}, { mode: 'minimal' })
    await created.settle()

    expect(created.registeredTools.has('orchestra_advisor')).toBe(false)
    expect(created.registeredTools.has('orchestra_skeptic')).toBe(false)
    // The scout stays: handoff is a core task, so minimal means no extra
    // reviewers rather than no delegation.
    expect(created.registeredTools.has('orchestra_scout')).toBe(true)
    // And the builder itself is still an agent.
    expect(created.agents.has('builder')).toBe(true)
  })

  test('standard mode registers everything, as before', async () => {
    // The default has to be a genuine no-op on the way in, or every existing
    // config silently lost a reviewer when this shipped.
    const created = await load()
    await created.settle()
    for (const role of ['scout', 'advisor', 'skeptic']) {
      expect(created.registeredTools.has(`orchestra_${role}`)).toBe(true)
    }
  })

  test('an explicit roles entry beats the mode', async () => {
    // A user who writes both gets what they wrote: the preset must not override
    // the specific, or a pinned advisor vanishes under `minimal`.
    const created = await load({}, { mode: 'minimal', roles: { advisor: 'opencode/cat-jam-free' } })
    await created.settle()
    expect(created.registeredTools.has('orchestra_advisor')).toBe(true)
    expect(created.registeredTools.has('orchestra_skeptic')).toBe(false)
  })

  test('an unrecognised mode loads, falls back, and says so', async () => {
    // A typo must not stop the plugin. It must not be silent either — otherwise
    // the user has a working plugin and no idea why their setting did nothing.
    const created = await load({}, { mode: 'lean' })
    await created.settle()
    expect(created.registeredTools.has('orchestra_advisor')).toBe(true)
    await created.runCommand('orchestra', invocation({ sessionID: 's1' }))
    expect(created.lastPrompt()?.text ?? '').toContain('is not one of')
  })

  test('a non-default mode is named in the report', async () => {
    // So two missing rows in the assignment table read as the mode's doing rather
    // than as a resolution failure.
    const created = await load({}, { mode: 'minimal' })
    await created.settle()
    await created.runCommand('orchestra', invocation({ sessionID: 's1' }))
    expect(created.lastPrompt()?.text ?? '').toContain('Operating mode: minimal')
  })

  test('strict mode changes the builder prompt', async () => {
    const created = await load({}, { mode: 'strict' })
    await created.settle()
    const system = created.agents.get('builder')?.system ?? ''
    expect(system).toContain('Strict mode')
    // And the reviewer tools are still there — strict adds frequency, not roles.
    expect(created.registeredTools.has('orchestra_advisor')).toBe(true)
  })

  test('a rejected hook registration fails the load after cleanup', async () => {
    const created = createPluginHarness({ models: mixedCatalog(), omit: ['session.hook.retry'] })
    harness = created
    // Deleting the hook member makes the registration call throw, which is
    // what a host-side rejection looks like from inside setup.
    await expect(entry.setup(created.ctx)).rejects.toThrow()
    // The agent transform registered above the throw must not survive it.
    for (const record of created.transforms) expect(record.disposed).toBe(true)
    teardown = undefined
  })
})

describe('provider concurrency options', () => {
  test('garbage providerConcurrency never takes the plugin down', async () => {
    // Permissive parsing: non-objects become absent, bad entries are dropped.
    for (const providerConcurrency of ['ollama', 2, ['ollama'], { ollama: 'many' }, { ollama: -1 }, { ollama: 0 }]) {
      const created = await load({}, { providerConcurrency })
      expect(created.agents.size).toBeGreaterThan(0)
    }
  })

  test('a configured provider no catalog model uses is named in the report', async () => {
    const created = await load({}, { providerConcurrency: { 'no-such-backend': 1 } })
    await created.runCommand('orchestra', invocation({ sessionID: 's1' }))
    expect(created.lastPrompt()?.text ?? '').toContain('no-such-backend')
  })
})
