/**
 * The skeptic role and its binding rule.
 *
 * What is worth asserting here is not that a fourth role exists — the resolver
 * returning something for every entry of `ROLES` is covered elsewhere. It is the
 * one property that makes the role worth its cost and that nothing else in the
 * suite would catch: **the skeptic must not run on the builder's model.**
 *
 * The reason is correlation, not taste. A panel's entire value is that the
 * critique comes from somewhere other than the proposal. Bound to the same
 * weights that wrote the plan, the skeptic either agrees with itself or invents
 * an objection to look useful — both are the failure the role exists to prevent,
 * and both read exactly like a successful panel in the output.
 *
 * So this file tests the rule, the two fallback tiers, and the honesty of the
 * report when the rule cannot be met.
 */

import { describe, expect, test } from 'bun:test'
import plugin from '../index'
import { roleSpec } from '../src/agents'
import { buildCandidates } from '../src/infer'
import type { PluginDefinitionLike } from '../src/plugin-types'
import { chooseVariant, resolveRoles, WEIGHTS } from '../src/roles'
import type { ModelInfo, RoleName } from '../src/types'
import { ROLES } from '../src/types'
import { model } from './fixture'
import type { PluginHarness } from './harness'
import { createPluginHarness } from './harness'

const refOf = (resolved: ReturnType<typeof resolveRoles>, role: RoleName) => {
  const ref = resolved.assignments[role]?.model
  return ref ? `${ref.providerID}/${ref.id}` : undefined
}

/**
 * Models deliberately identical apart from price.
 *
 * This is the adversarial shape: with no signal to tell the roles apart, every
 * role ranks the same order, so any independence rule that only looks at "the
 * best model" quietly collapses and two roles land on one model. The prices
 * still separate scout (cheapness) from advisor (reasoning) enough to prove the
 * skeptic is doing deliberate avoidance rather than luck.
 */
function undifferentiatedCatalog(size: number): ModelInfo[] {
  return Array.from({ length: size }, (_, index) => model(`flat-${index}`, index, index, { name: `flat-${index}` }))
}

describe('the skeptic role', () => {
  test('every role gets an assignment, skeptic included', () => {
    const resolved = resolveRoles({ catalog: undifferentiatedCatalog(4) })
    for (const role of ROLES) {
      expect(resolved.assignments[role]).toBeDefined()
      expect(resolved.assignments[role]?.source).toBe('detected')
    }
  })

  test('is read-only and cannot implement', () => {
    const spec = roleSpec('skeptic')
    expect(spec.mode).toBe('subagent')
    const rule = (action: string) => spec.permissions.filter(entry => entry.action === action).at(-1)?.effect
    expect(rule('edit')).toBe('deny')
    expect(rule('shell')).toBe('deny')
    expect(rule('subagent')).toBe('deny')
  })

  test('is hidden by the same option that hides the advisor', () => {
    // One switch for both on-call reviewers. Two switches would let a config
    // hide the advisor and leave the skeptic listed, advertising a review surface
    // the user did not ask for.
    expect(roleSpec('skeptic', { hideAdvisor: true }).hidden).toBe(true)
    expect(roleSpec('advisor', { hideAdvisor: true }).hidden).toBe(true)
    expect(roleSpec('scout', { hideAdvisor: true }).hidden).toBe(false)
  })
})

describe('skeptic binding', () => {
  test("never shares the builder's model when the catalog allows it", () => {
    for (const size of [4, 5, 8]) {
      const resolved = resolveRoles({ catalog: undifferentiatedCatalog(size) })
      expect(refOf(resolved, 'skeptic')).not.toBe(refOf(resolved, 'builder'))
    }
  })

  test('takes a model no other role holds when there are enough to go round', () => {
    // The stronger form. "Not the builder" is satisfiable by landing on the
    // advisor or the scout, which is how the rule passed while the report still
    // showed two roles contending for one backend.
    const resolved = resolveRoles({ catalog: undifferentiatedCatalog(4) })
    const held = ROLES.filter(role => role !== 'skeptic').map(role => refOf(resolved, role))
    expect(refOf(resolved, 'skeptic')).not.toBe(held.find(Boolean))
    for (const role of ROLES) {
      expect(resolved.assignments[role]?.sharedWith ?? []).toEqual([])
    }
  })

  test('falls back to a shared model rather than leaving the role empty', () => {
    // One model means every role shares it. The role must still resolve — a
    // panel that silently disappears is worse than a correlated one.
    const resolved = resolveRoles({ catalog: undifferentiatedCatalog(1) })
    expect(resolved.assignments.skeptic?.model).toBeDefined()
    expect(resolved.assignments.skeptic?.source).toBe('fallback')
  })

  test('says so when the skeptic is forced onto the builder', () => {
    const resolved = resolveRoles({ catalog: undifferentiatedCatalog(1) })
    const notes = resolved.notes.join(' ')
    expect(notes).toContain('Skeptic shares a model with Builder')
    expect(notes).toMatch(/weaker than it reads/)
  })

  test('says so when it is forced onto the advisor', () => {
    // Two models: enough to keep the skeptic off the builder, not enough to keep
    // it off the advisor as well. This is the weaker correlation, and it must be
    // reported as such rather than presented as independence.
    const resolved = resolveRoles({ catalog: undifferentiatedCatalog(2) })
    const ref = refOf(resolved, 'skeptic')
    expect(ref).toBeDefined()
    if (ref === refOf(resolved, 'advisor')) {
      expect(resolved.notes.join(' ')).toMatch(/Skeptic shares a model with Advisor/)
      expect(resolved.notes.join(' ')).toMatch(/correlated/)
    }
  })

  test('a pin overrides the rule without a complaint', () => {
    // The user pinning a role is a decision, not a resolver bug. Objecting would
    // be the plugin arguing with someone who already answered the question.
    const resolved = resolveRoles({
      catalog: undifferentiatedCatalog(4),
      pins: { skeptic: { model: 'anthropic/flat-0' } }
    })
    expect(resolved.assignments.skeptic?.source).toBe('pin')
    expect(refOf(resolved, 'skeptic')).toBe('anthropic/flat-0')
  })
})

describe('/panel', () => {
  const entry = plugin as PluginDefinitionLike

  const PANEL_MODELS = [
    model('cheap-free', 0, 0, { name: 'cheap' }),
    model('mid-free', 5, 5, { name: 'mid' }),
    model('deep-free', 30, 30, { name: 'deep' }),
    model('wide-free', 12, 12, { name: 'wide' })
  ]

  async function loaded(models = PANEL_MODELS, options: Record<string, unknown> = {}) {
    const harness = createPluginHarness({ models, ...options })
    await entry.setup(harness.ctx)
    await harness.settle()
    return harness
  }

  const lastPrompt = (harness: PluginHarness) => harness.prompts.at(-1)?.text ?? ''

  test('is registered as a command', async () => {
    const harness = await loaded()
    expect(harness.commands.has('panel')).toBe(true)
  })

  test('refuses to run with nothing to review', async () => {
    // The original built a request around "the proposal below" and, invoked bare,
    // sent two reviewers an empty subject — burning two model turns on nothing.
    const harness = await loaded()
    await harness.commands.get('panel')!.execute({ sessionID: 'ses_panel', prompt: { text: '' } })
    await harness.settle()

    expect(lastPrompt(harness)).toMatch(/nothing to review/i)
    expect(harness.calls).not.toContain('session.create')
  })

  test('runs BOTH reviewers over their own sessions', async () => {
    // The load-bearing behaviour. The builder's own `subagent` launch opens a
    // child session, which a free tier refuses; `dispatchRole` opens an ordinary
    // session instead. The panel therefore dispatches itself rather than asking
    // the builder to pick the right tool.
    const harness = await loaded()
    await harness.commands
      .get('panel')!
      .execute({ sessionID: 'ses_panel', prompt: { text: 'add a cache to the resolver' } })
    await harness.settle()

    expect(harness.calls.filter((entry: string) => entry === 'session.switchAgent:skeptic')).toHaveLength(1)
    expect(harness.calls.filter((entry: string) => entry === 'session.switchAgent:advisor')).toHaveLength(1)
  })

  test('gives both reviewers the same proposal', async () => {
    const harness = await loaded()
    await harness.commands
      .get('panel')!
      .execute({ sessionID: 'ses_panel', prompt: { text: 'add a cache to the resolver' } })
    await harness.settle()

    expect(lastPrompt(harness)).toContain('Proposal under review:')
    expect(lastPrompt(harness)).toContain('add a cache to the resolver')
  })

  test('presents both verdicts under their own headings', async () => {
    const harness = await loaded()
    harness.sessionReplies['add a cache'] = 'VERDICT: proceed'
    await harness.commands.get('panel')!.execute({ sessionID: 'ses_panel', prompt: { text: 'add a cache' } })
    await harness.settle()

    const text = lastPrompt(harness)
    expect(text).toContain('### Skeptic')
    expect(text).toContain('### Advisor')
    expect(text).toMatch(/ran independently/i)
  })

  test('does not re-run the reviews it just completed', async () => {
    // The panel already spent two model turns. Handing the builder an instruction
    // to "launch the reviewers" made it run a second, near-identical panel.
    const harness = await loaded()
    await harness.commands.get('panel')!.execute({ sessionID: 'ses_panel', prompt: { text: 'add a cache' } })
    await harness.settle()

    const text = lastPrompt(harness)
    expect(text).toMatch(/already complete/i)
    expect(text).toMatch(/do not re-run/i)
    expect(text).not.toMatch(/orchestra_skeptic/)
  })

  test('tells the builder not to merge the two verdicts', async () => {
    const harness = await loaded()
    await harness.commands.get('panel')!.execute({ sessionID: 'ses_panel', prompt: { text: 'add a cache' } })
    await harness.settle()

    const text = lastPrompt(harness)
    expect(text).toMatch(/do not merge them into one verdict/i)
    expect(text).toMatch(/does not block/i)
  })

  test("warns when the skeptic is bound to the builder's model", async () => {
    // One model means the skeptic cannot be independent. The command must say so
    // rather than presenting a correlated second opinion as a panel.
    const harness = await loaded([model('only-free', 0, 0, { name: 'only' })])
    await harness.commands.get('panel')!.execute({ sessionID: 'ses_panel', prompt: { text: 'add a cache' } })
    await harness.settle()

    expect(lastPrompt(harness)).toMatch(/WARNING: the skeptic is bound to the builder's model/)
  })

  test('says nothing about correlation when the roles are distinct', async () => {
    const harness = await loaded()
    await harness.commands.get('panel')!.execute({ sessionID: 'ses_panel', prompt: { text: 'add a cache' } })
    await harness.settle()

    expect(lastPrompt(harness)).not.toMatch(/correlated/i)
  })

  test('a reviewer whose transcript says nothing points at the TUI rather than inventing a cause', async () => {
    // With an empty transcript there is no reason to report — nothing came back
    // and nothing said why. The command says how many opinions are missing and
    // leaves the cause where the user will find it, instead of restating a
    // session error it was never told. When the transcript *does* carry a
    // refusal, the section names it instead.
    //
    // Driven by "no reply registered" rather than an injected failure: the
    // harness tracks the active session agent in one field, so a failure keyed
    // to `skeptic` would be attributed to whichever dispatch last set it, and
    // the two run concurrently. Asserting on that would be asserting on a race
    // in the mock rather than on the command.
    const harness = await loaded()
    await harness.commands.get('panel')!.execute({ sessionID: 'ses_panel', prompt: { text: 'add a cache' } })
    await harness.settle()

    const text = lastPrompt(harness)
    expect(text).toMatch(/2 of 2 reviewers did not answer/)
    expect(text).toMatch(/not a panel/i)
    expect(text).toMatch(/missing opinion, not as agreement/i)
    // The cause is left to the TUI when there is nothing to report here.
    expect(text).toMatch(/session itself is in the TUI/i)
  })

  test('is not offered as a mandatory gate', async () => {
    const harness = await loaded()
    const description = harness.commands.get('panel')!.description
    expect(description).toMatch(/independently/i)
    expect(description).not.toMatch(/must|required|always/i)
  })

  test('a reviewer that was refused says why, not that it stayed silent', async () => {
    // The whole-message bug: both reviewers refused on credentials and the panel
    // reported "the agent produced no reply". That names a symptom in this plugin
    // for a cause at the provider, and it sent the reader looking in the wrong
    // place for as long as it took to find the host log. The reason was on the
    // assistant message the transcript already contained.
    //
    // Nothing is registered in `sessionReplies`, so both dispatches end with no
    // reply — which is the real shape of the failure, not an injected throw.
    const harness = await loaded(PANEL_MODELS, {
      contextMessages: [
        {
          type: 'assistant',
          agent: 'skeptic',
          content: [],
          error: {
            type: 'AI.Error.Authentication',
            message: "OpenCode's free tier can only be used from within OpenCode"
          }
        }
      ]
    })
    await harness.commands.get('panel')!.execute({ sessionID: 'ses_panel', prompt: { text: 'add a cache' } })
    await harness.settle()

    const text = lastPrompt(harness)
    expect(text).toContain('free tier')
    expect(text).not.toContain('produced no reply')
    // Still not a panel, and still says so rather than inventing agreement.
    expect(text).toMatch(/did not answer/)
    expect(text).toMatch(/not a panel/i)
  })
})

describe('skeptic reasoning effort', () => {
  /** `chooseVariant` reads inferred `Signals`, not the catalog shape. */
  const signalsFor = (catalog: ModelInfo[]) => buildCandidates(catalog, WEIGHTS.scout).candidates

  test('runs below the advisor on a model with several efforts', () => {
    // The last available hedge when two reviewers share weights: not the same
    // computation twice. One notch of depth is worth paying for this.
    const [solo] = signalsFor([model('solo', 10, 10, { reasoning: { low: 0.25, medium: 0.5, high: 0.9 } })])
    expect(solo).toBeDefined()
    expect(chooseVariant(solo!, 'skeptic')).not.toBe(chooseVariant(solo!, 'advisor'))
    // And it must still be a real effort setting, not a fallback to none.
    expect(chooseVariant(solo!, 'skeptic')).toBe('medium')
  })

  test('still takes the only effort a model offers', () => {
    const [solo] = signalsFor([model('solo', 10, 10, { reasoning: { high: 0.9 } })])
    expect(chooseVariant(solo!, 'skeptic')).toBe('high')
  })

  test('takes nothing from a model with no variants', () => {
    const [solo] = signalsFor([model('solo', 10, 10, { variants: [] })])
    expect(chooseVariant(solo!, 'skeptic')).toBeUndefined()
  })
})
