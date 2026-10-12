/**
 * Report rendering.
 *
 * Only the sections that carry a policy decision are asserted here. The report
 * is pasted into a session prompt, so what matters is that a model reading it
 * learns the same thing a human does: which models were dropped for being dead,
 * and which are refused here but still eligible. The rejection section exists
 * because "scout kept failing" is otherwise indistinguishable from "the plugin
 * is not delegating".
 */

import { describe, expect, test } from 'bun:test'
import { renderReport } from '../src/report'
import { resolveRoles } from '../src/roles'
import type { ModelInfo, ResolveOutput } from '../src/types'

const CATALOG: ModelInfo[] = [
  {
    id: 'ling-3.1-flash-free',
    providerID: 'opencode',
    name: 'Ling Flash',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    cost: [{ input: 0, output: 0 }],
    time: { released: 1748000000000 },
    limit: { context: 200000, output: 8192 }
  },
  {
    id: 'claude-sonnet-4-5',
    providerID: 'anthropic',
    name: 'Sonnet',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    cost: [{ input: 3, output: 15 }],
    time: { released: 1749000000000 },
    limit: { context: 200000, output: 32000 },
    variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }]
  }
]

const resolved: ResolveOutput = resolveRoles({ catalog: CATALOG })

const REJECTED =
  '`opencode/ling-3.1-flash-free` refused 2 request(s) from outside the host app, so it stays in detection: free tier can only be used by opencode.'
const QUARANTINED = '`anthropic/claude-opus-4-1` excluded after 1 failure(s): model has been deprecated'

describe('report: rejected models', () => {
  test('renders a rejected line under its own heading', () => {
    const output = renderReport({ resolved, rejected: [REJECTED] })
    expect(output).toContain('### Rejected models')
    expect(output).toContain(`- ${REJECTED}`)
  })

  test('says why the model is kept, so the section cannot be read as a quarantine', () => {
    const output = renderReport({ resolved, rejected: [REJECTED] })
    expect(output).toContain('still lists them as active')
    expect(output).toContain('stay in detection on purpose')
    // A rejected model must not be described as excluded from detection.
    expect(output).not.toContain('### Quarantined models')
  })

  test('the rejection section is absent when nothing was refused', () => {
    const output = renderReport({ resolved, rejected: [] })
    expect(output).not.toContain('### Rejected models')
    const without = renderReport({ resolved })
    expect(without).not.toContain('### Rejected models')
  })

  test('rejections and quarantines render side by side without crossing over', () => {
    // `verbose`, because this asserts section isolation rather than what the
    // default report shows. The default is narrowed to the models a role is
    // actually running, and `QUARANTINED` names a model absent from the catalog
    // — background by definition. The default-report contract is tested below.
    const output = renderReport({ resolved, quarantine: [QUARANTINED], rejected: [REJECTED], verbose: true })
    const quarantineAt = output.indexOf('### Quarantined models')
    const rejectedAt = output.indexOf('### Rejected models')
    expect(quarantineAt).toBeGreaterThan(-1)
    expect(rejectedAt).toBeGreaterThan(quarantineAt)
    expect(output).toContain(`- ${QUARANTINED}`)
    expect(output).toContain(`- ${REJECTED}`)
    // Each entry stays under its own section: the refusals follow the rejection
    // heading, never the quarantine one.
    expect(output.slice(rejectedAt)).toContain(REJECTED)
    expect(output.slice(quarantineAt, rejectedAt)).not.toContain(REJECTED)
  })
})

describe('report: the rest of the output is untouched', () => {
  test('still renders the role table and the pin line', () => {
    const output = renderReport({ resolved, rejected: [REJECTED], pinPath: '.opencode/orchestra.json' })
    expect(output).toContain('| Role | Model | Chosen by |')
    expect(output).toContain('No pin file. Run /orchestra-pin to freeze this assignment into .opencode/orchestra.json.')
  })

  test('an empty candidate set still renders', () => {
    const empty = resolveRoles({ catalog: [] })
    const output = renderReport({ resolved: empty, rejected: [REJECTED] })
    expect(output).toContain('### Rejected models')
    expect(output).toContain(`- ${REJECTED}`)
  })
})

describe('report: plugin version', () => {
  test('prints the version line when one is given', () => {
    const output = renderReport({ resolved, version: '0.1.0' })
    expect(output).toContain('Plugin version: `0.1.0`')
  })

  test('omits the version line when none is given, so old callers are untouched', () => {
    const output = renderReport({ resolved })
    expect(output).not.toContain('Plugin version:')
  })
})

describe('report: the default stays short without losing the open risks', () => {
  // The model the builder actually runs on, from this catalog.
  const assignedRef = (resolved.assignments.builder?.model ?? {}) as { providerID?: string; id?: string }
  const BUILDER_REF = `${assignedRef.providerID}/${assignedRef.id}`
  const ON_BUILDER =
    '`' +
    BUILDER_REF +
    '` refused 2 request(s) from outside the host app, so it stays in detection: free tier can only be used by opencode.'
  const ON_SOMETHING_ELSE =
    '`openai/gpt-5.2` refused 1 request(s) from outside the host app, so it stays in detection: free tier can only be used by opencode.'

  test('a refused model a role is running on is named by default', () => {
    // `assignment.verification` is set only after a probe, so a model refused
    // during dispatch reads as merely "unverified" on its own row — this
    // section is the only place that says otherwise, and hiding it would hide an
    // open problem.
    const output = renderReport({ resolved, rejected: [ON_BUILDER] })
    expect(output).toContain('### Rejected models')
    expect(output).toContain(ON_BUILDER)
  })

  test('a refusal about a model nobody is running is left to /orchestra all', () => {
    const output = renderReport({ resolved, rejected: [ON_SOMETHING_ELSE] })
    expect(output).not.toContain('### Rejected models')
    // And it is not silently lost: the full listing has it.
    expect(renderReport({ resolved, rejected: [ON_SOMETHING_ELSE], verbose: true })).toContain(ON_SOMETHING_ELSE)
  })

  test('the shortened section says where the rest went', () => {
    // Otherwise "one entry" reads as "this is all of them".
    const output = renderReport({ resolved, rejected: [ON_BUILDER, ON_SOMETHING_ELSE] })
    expect(output).toContain('the ones a role is currently running')
  })

  test('a line whose ref cannot be read is kept, not dropped by omission', () => {
    const unparsable = 'something failed in a way this filter cannot classify'
    expect(renderReport({ resolved, rejected: [unparsable] })).toContain(unparsable)
  })

  test('with nothing assigned, nothing is background', () => {
    // An empty catalog is the one case where the failure list is the only
    // explanation of why no model was detected.
    const empty = resolveRoles({ catalog: [] })
    expect(renderReport({ resolved: empty, rejected: [REJECTED] })).toContain('### Rejected models')
  })

  test('warnings stay on by default', () => {
    // Warnings are the open risks. Hiding them to save lines would defeat the
    // report's purpose.
    const output = renderReport({ resolved, warnings: ['every candidate comes from one provider'] })
    expect(output).toContain('### Worth knowing')
    expect(output).toContain('every candidate comes from one provider')
  })

  test('assigned, reachable and used stay three separate statements', () => {
    // Collapsing these is how a refused model reads as healthy.
    const refused = resolveRoles({ catalog: CATALOG })
    const assignment = refused.assignments.scout
    if (assignment) assignment.verification = 'refused'
    const output = renderReport({ resolved: refused })
    expect(output).toContain('REFUSED at request time')
    expect(output).toContain('This model refused a real request.')
    // And the healthy case is not given the refused wording.
    const ok = resolveRoles({ catalog: CATALOG })
    const okAssignment = ok.assignments.scout
    if (okAssignment) okAssignment.verification = 'verified'
    expect(renderReport({ resolved: ok })).toContain('answers')
  })
})

describe('report: a reason says which kind of fact it rests on', () => {
  // Nothing in a catalog says `flash` is fast or `coder` codes. Those signals are
  // keyword-derived, and a report that prints them beside a measured price
  // without saying so mixes two kinds of fact.
  //
  // One model, so scout is guaranteed the keyword'd one — with several, the
  // distinct-model preference hands it to a plain model instead and the reason
  // under test is never emitted.
  const withFlash = resolveRoles({
    catalog: [
      {
        id: 'model-flash-free',
        providerID: 'opencode',
        name: 'model-flash-free',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        cost: [{ input: 0, output: 0 }],
        time: { released: 1749000000000 },
        limit: { context: 200000, output: 8192 }
      }
    ]
  })
  const lines = (role: 'scout') => withFlash.assignments[role].reasons

  test('a keyword-derived superlative is marked as inferred', () => {
    const fastest = lines('scout').find(line => line.startsWith('Fastest model available'))
    expect(fastest).toBeDefined()
    expect(fastest).toContain('inferred from the family name')
  })

  test('a measured fact is not marked', () => {
    // The price is a catalog fact. Marking it would make the marker noise.
    const price = lines('scout').find(line => line.includes('Free tier') || line.includes('per Mtok'))
    expect(price).toBeDefined()
    expect(price).not.toContain('inferred')
  })

  test('a measured limit is not marked', () => {
    const limit = lines('scout').find(line => line.includes('context /'))
    expect(limit).toBeDefined()
    expect(limit).not.toContain('inferred')
  })

  test('an unbranded model claims nothing inferred', () => {
    // No keyword fired, so no reason should be qualified. Otherwise the marker
    // becomes wallpaper and stops meaning anything.
    const plain = resolveRoles({ catalog: [{ ...CATALOG[1]!, id: 'plain-model', name: 'plain-model' }] })
    expect(plain.assignments.builder.reasons.join('\n')).not.toContain('inferred from the family name')
  })

  test('model diversity stays a preference, not a purpose', () => {
    // Two roles sharing a model is reported, and the report says to read the
    // verdicts as correlated rather than treating the collision as an error to
    // route around at any cost.
    const shared = resolveRoles({ catalog: [CATALOG[1]!] })
    const output = renderReport({ resolved: shared })
    expect(output).toContain('shares a model')
  })
})
