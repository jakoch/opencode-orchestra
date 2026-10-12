/**
 * Advisory findings become claims.
 *
 * Read-only roles return prose, which left the builder with two bad options:
 * re-verify everything a role said, or believe it. The claims block is the middle
 * state — what was said, where it points, and what this session observed behind
 * it — carried as a reference rather than a copy, because a copy is the token
 * cost the delegation was supposed to avoid paying.
 *
 * Two properties are asserted apart throughout, because conflating them is the
 * failure this feature could introduce:
 *
 *   - **Advisory.** An unbacked claim is a gap in the report. Nothing here
 *     blocks the builder, throws, or fails a request, and a claim that cannot be
 *     shaped is dropped with a reason rather than raised.
 *   - **Structural only.** A claim is supported by what this session *observed*,
 *     never by re-reading the role's work. Re-running a scout's search is the
 *     delegation that was already paid for (`docs/roles.md`).
 */

import { describe, expect, test } from 'bun:test'
import { claimsFromEnvelope, EVIDENCE_CLAIM_CAP, EvidenceStore } from '../src/evidence'
import { renderReport } from '../src/report'
import { resolveRoles } from '../src/roles'
import type { Claim, ClaimSupport, HandoffEnvelope, ModelInfo } from '../src/types'

const SESSION = 'session-1'

/** Runs the check the store recognises as verification. */
function runTests(store: EvidenceStore, now: number, command = 'bun test') {
  store.record(SESSION, 'bash', { command }, 'completed', now)
}

function write(store: EvidenceStore, now: number, filePath: string) {
  store.record(SESSION, 'edit', { filePath }, 'completed', now)
}

/** Support of the single claim filed under `SESSION`. */
function supportOf(store: EvidenceStore): ClaimSupport {
  const records = store.claims(SESSION)
  expect(records.length).toBe(1)
  return records[0]!.support
}

function gapOf(store: EvidenceStore): string {
  return store.claims(SESSION)[0]!.gap ?? ''
}

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    role: 'scout',
    claim: 'the resolver drops the ranked order',
    refs: ['src/roles.ts:200'],
    ...overrides
  }
}

const CATALOG: ModelInfo[] = [
  {
    id: 'flash-free',
    providerID: 'opencode',
    name: 'flash',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    cost: [{ input: 0, output: 0 }],
    time: { released: 1748000000000 },
    limit: { context: 200000, output: 8192 }
  },
  {
    id: 'sonnet-4-5',
    providerID: 'anthropic',
    name: 'sonnet',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    cost: [{ input: 3, output: 15 }],
    time: { released: 1749000000000 },
    limit: { context: 200000, output: 32000 }
  }
]

function render(claims?: string[], signals?: string[]) {
  return renderReport({
    resolved: resolveRoles({ catalog: CATALOG }),
    applied: {},
    pinPath: '.opencode/orchestra.json',
    pinStatus: 'pinned',
    warnings: undefined,
    signals,
    claims
  })
}

describe('claims: a reference, not a copy', () => {
  test('a claim is one line however long the reply was', () => {
    const store = new EvidenceStore()
    const transcript = `the resolver drops the ranked order\n\nand here is the whole traceback\n${'x'.repeat(500)}`
    store.recordClaim(SESSION, claim({ claim: transcript }))

    const text = store.claims(SESSION)[0]!.claim.claim
    expect(text).not.toContain('\n')
    // Bounded, so a claim can never re-inflate into the transcript it replaced.
    expect(text.length).toBeLessThanOrEqual(201)
    expect(text).toStartWith('the resolver drops the ranked order')
  })

  test('a claim keeps references rather than what was found behind them', () => {
    const store = new EvidenceStore()
    store.recordClaim(SESSION, claim({ refs: ['src/roles.ts:200'] }))
    expect(store.claims(SESSION)[0]!.claim.refs).toEqual(['src/roles.ts:200'])
  })

  test('a reference that is not `path:line` is dropped, not rendered', () => {
    const store = new EvidenceStore()
    store.recordClaim(
      SESSION,
      claim({ refs: ['src/roles.ts:200', 'https://example.com:8080', 'the whole thing is 8080 wide'] as never })
    )
    expect(store.claims(SESSION)[0]!.claim.refs).toEqual(['src/roles.ts:200'])
  })
})

describe('claims: what a session can actually say about them', () => {
  test('a command the builder ran after its last edit is observed', () => {
    const store = new EvidenceStore()
    runTests(store, 100)
    store.recordClaim(SESSION, claim({ role: 'builder', command: 'bun test' }), 200)

    expect(supportOf(store)).toBe('observed')
    expect(store.claims(SESSION)[0]!.backedBy).toContain('bun test')
  })

  test('the same claim with no recorded run is unbacked, and says why', () => {
    const store = new EvidenceStore()
    store.recordClaim(SESSION, claim({ role: 'builder', command: 'bun test' }))

    expect(supportOf(store)).toBe('unbacked')
    expect(gapOf(store)).toContain('no verification run has been recorded')
  })

  test('a file written after the run puts the claim back in the gap', () => {
    // The file tracker is the support here, not a second opinion: an unverified
    // file is precisely the reason a past run does not cover the present.
    const store = new EvidenceStore()
    runTests(store, 100)
    store.recordClaim(SESSION, claim({ role: 'builder', command: 'bun test' }), 200)
    expect(supportOf(store)).toBe('observed')

    write(store, 300, '/repo/src/report.ts')
    expect(supportOf(store)).toBe('unbacked')
    expect(gapOf(store)).toContain('changed after the last run')
  })

  test('a command that is not a check is reported, not quietly backed', () => {
    const store = new EvidenceStore()
    runTests(store, 100)
    store.recordClaim(SESSION, claim({ role: 'builder', command: 'git log --oneline' }), 200)

    expect(supportOf(store)).toBe('unbacked')
    expect(gapOf(store)).toContain('not a check')
  })

  test('a different command is not a pass for the cited one', () => {
    const store = new EvidenceStore()
    store.record(SESSION, 'bash', { command: 'bun run lint' }, 'completed', 100)
    store.recordClaim(SESSION, claim({ role: 'builder', command: 'bun test' }), 200)

    expect(supportOf(store)).toBe('unbacked')
    expect(gapOf(store)).toContain('not the cited one')
  })

  test('a claim with only references is referenced, never observed', () => {
    const store = new EvidenceStore()
    runTests(store, 100)
    store.recordClaim(SESSION, claim(), 200)

    expect(supportOf(store)).toBe('referenced')
    // The wording matters: a location is not a result, and reading it as one is
    // how "the model said so" starts looking like "the model was right".
    expect(store.claims(SESSION)[0]!.backedBy).toContain('location and not a result')
  })

  test('a claim citing nothing at all is a gap with nothing behind it', () => {
    const store = new EvidenceStore()
    store.recordClaim(SESSION, claim({ claim: 'it is probably fine', refs: [] }))
    expect(supportOf(store)).toBe('unbacked')
    expect(gapOf(store)).toContain('neither a reference nor a command')
  })

  test('a reference inside the prose is not a reference', () => {
    const store = new EvidenceStore()
    store.recordClaim(SESSION, claim({ claim: 'the resolver drops it at src/roles.ts:200', refs: [] }))
    expect(supportOf(store)).toBe('unbacked')
  })
})

describe('claims: the verification boundary is mechanical', () => {
  test('a read-only role cannot back a command claim, even with a run on record', () => {
    for (const role of ['scout', 'advisor'] as const) {
      const store = new EvidenceStore()
      runTests(store, 100)
      store.recordClaim(SESSION, claim({ role, command: 'bun test' }), 200)

      expect(supportOf(store)).toBe('unbacked')
      expect(gapOf(store)).toContain('denied shell')
      expect(gapOf(store)).toContain('only the builder can settle it')
    }
  })

  test('the builder backs a command claim only because a run was recorded', () => {
    // Together with the read-only cases above, this pins the derivation: the
    // difference between `observed` and `denied shell` is read from the agent
    // permissions, not from a table this test could restate and have both drift.
    const store = new EvidenceStore()
    runTests(store, 100)
    store.recordClaim(SESSION, claim({ role: 'builder', command: 'bun test' }), 200)
    expect(supportOf(store)).toBe('observed')

    // The same builder claim with the run removed falls back to the gap, so the
    // verdict came from the session record and not from the role alone.
    const bare = new EvidenceStore()
    bare.recordClaim(SESSION, claim({ role: 'builder', command: 'bun test' }))
    expect(supportOf(bare)).toBe('unbacked')
  })
})

describe('claims: advisory posture', () => {
  test('a claim that cannot be shaped is dropped with a reason, never raised', () => {
    const store = new EvidenceStore()
    expect(store.recordClaim(SESSION, claim({ role: 'nobody' as never }))).toEqual({
      accepted: false,
      reason: 'the claim names no known role'
    })
    expect(store.recordClaim(SESSION, claim({ claim: '   ' }))).toEqual({
      accepted: false,
      reason: 'the claim carried no text'
    })
    expect(store.recordClaim(SESSION, null as never)).toEqual({
      accepted: false,
      reason: 'the claim names no known role'
    })
    // Nothing was recorded, and the store is still usable afterwards.
    expect(store.describeClaims(SESSION)).toBeUndefined()
    runTests(store, 100)
    expect(store.describeClaims(SESSION)).toBeUndefined()
    expect(store.snapshot(SESSION).verificationRuns).toBe(1)
  })

  test('filing a claim does not touch the file tracker', () => {
    // No parallel tracker: a claim is not debt, and a report that counted both
    // would double-count every session.
    const store = new EvidenceStore()
    store.recordClaim(SESSION, claim({ command: 'bun test' }))

    expect(store.count(SESSION)).toBe(0)
    expect(store.describe(SESSION)).toBeUndefined()
    expect(store.snapshot(SESSION).unverified).toEqual([])
  })

  test('support is read live, so a settled claim stops being a gap', () => {
    // A claim filed before the checks ran was true-but-unbacked for a moment.
    // Freezing support at filing time would have the report calling finished
    // work unbacked for the rest of the session.
    const store = new EvidenceStore()
    store.recordClaim(SESSION, claim({ role: 'builder', command: 'bun test' }), 100)
    expect(supportOf(store)).toBe('unbacked')

    runTests(store, 200)
    expect(supportOf(store)).toBe('observed')
  })

  test('a claim outlives nothing: prune and clear take it with the session', () => {
    const store = new EvidenceStore({ ttlMs: 1000 })
    store.recordClaim(SESSION, claim(), 1000)
    expect(store.describeClaims(SESSION)).toBeDefined()

    store.prune(3000)
    expect(store.describeClaims(SESSION)).toBeUndefined()

    store.recordClaim(SESSION, claim(), 4000)
    store.clear(SESSION)
    expect(store.describeClaims(SESSION)).toBeUndefined()
  })

  test('claims are bounded, newest kept', () => {
    const store = new EvidenceStore()
    for (let index = 0; index <= EVIDENCE_CLAIM_CAP; index++) {
      store.recordClaim(SESSION, claim({ claim: `finding ${index}` }), index)
    }
    const records = store.claims(SESSION)
    expect(records.length).toBe(EVIDENCE_CLAIM_CAP)
    expect(records.at(-1)!.claim.claim).toBe(`finding ${EVIDENCE_CLAIM_CAP}`)
  })
})

describe('claims: rendered in /orchestra', () => {
  test('claims land in the existing "This session" section', () => {
    const store = new EvidenceStore()
    store.recordClaim(SESSION, claim())

    const output = render(store.describeClaims(SESSION))
    expect(output).toContain('### This session')
    expect(output).toContain('- Claims below are references, not copies')
    expect(output).toContain('`src/roles.ts:200`')
    // No new section: a claims heading would read as a verdict on the roles.
    expect(output).not.toContain('### Claims')
    expect(output.match(/### This session/g)?.length).toBe(1)
  })

  test('each claim is one bullet, not two', () => {
    // `renderReport` owns the bullet prefix, so `describeClaims` must not add
    // one. A doubled `- -` would render as a code block in some hosts and hide
    // the very lines this exists to surface.
    const store = new EvidenceStore()
    store.recordClaim(SESSION, claim())
    const output = render(store.describeClaims(SESSION))
    expect(output).toContain('- Scout — "the resolver drops the ranked order')
    expect(output).not.toContain('- - ')
  })

  test('claims render alongside the existing signals, not instead of them', () => {
    const store = new EvidenceStore()
    runTests(store, 100)
    store.recordClaim(SESSION, claim(), 200)

    const output = render(store.describeClaims(SESSION), [store.describe(SESSION)!])
    expect(output).toContain('Last verification run: `bun test`')
    expect(output).toContain('Claims below are references')
  })

  test('the block states what may and may not be done with a gap', () => {
    const store = new EvidenceStore()
    store.recordClaim(SESSION, claim({ role: 'builder', command: 'bun test' }))
    const output = render(store.describeClaims(SESSION))

    expect(output).toContain('None of them is a gate')
    expect(output).toContain('An unbacked claim is a gap, not a failure')
    expect(output).toContain('do not re-run a search a role already ran')
  })

  test('no claims means no section at all', () => {
    const store = new EvidenceStore()
    expect(render(store.describeClaims(SESSION))).not.toContain('### This session')
    expect(render([])).not.toContain('### This session')
  })

  test('an unbacked claim does not stop the rest of the report rendering', () => {
    const store = new EvidenceStore()
    store.recordClaim(SESSION, claim({ role: 'advisor', command: 'npm test' }))

    const output = render(store.describeClaims(SESSION))
    expect(output).toContain('| Role | Model | Chosen by |')
    expect(output).toContain('Pin file (.opencode/orchestra.json): pinned')
    expect(output).toContain('nothing here — the Advisor is denied shell')
  })

  test('the session is capped, and the rest is counted rather than printed', () => {
    const store = new EvidenceStore()
    for (let index = 0; index < 7; index++) {
      store.recordClaim(SESSION, claim({ claim: `finding ${index}` }), index)
    }
    const block = store.describeClaims(SESSION)!
    expect(block.filter(entry => entry.startsWith('Scout —'))).toHaveLength(4)
    expect(block).toContain('3 earlier claim(s) from this session are not shown.')
  })
})

describe('claims: the handoff envelope, narrowed', () => {
  const envelope: HandoffEnvelope = {
    findings: ['the resolver discards the ranked order, so no retry can use it'],
    filesTouched: ['src/roles.ts:200'],
    confidence: 'high',
    openQuestions: ['nothing checks the fallback path']
  }

  test('findings become claims carrying the envelope refs', () => {
    expect(claimsFromEnvelope('scout', envelope)).toEqual([
      {
        role: 'scout',
        claim: 'the resolver discards the ranked order, so no retry can use it',
        refs: ['src/roles.ts:200']
      }
    ])
  })

  test('a missing FILES section leaves claims unreferenced rather than guessed', () => {
    // The soft edge, taken at face value. Borrowing a reference that might
    // belong to another finding would be worse than reporting none.
    const withoutFiles = claimsFromEnvelope('advisor', { ...envelope, filesTouched: [] })
    expect(withoutFiles[0]!.refs).toBeUndefined()
    expect(withoutFiles[0]!.role).toBe('advisor')
  })

  test('bounded by the envelope limit, and never by the reply', () => {
    const many = claimsFromEnvelope('scout', {
      ...envelope,
      findings: Array.from({ length: 12 }, (_, index) => `finding ${index}`)
    })
    expect(many.length).toBe(5)
  })

  test('a malformed envelope yields no claims and no exception', () => {
    expect(claimsFromEnvelope('scout', null as never)).toEqual([])
    expect(claimsFromEnvelope('scout', { ...envelope, findings: ['', '   '] })).toEqual([])
  })

  test('narrowed claims go straight into the store and report', () => {
    const store = new EvidenceStore()
    for (const entry of claimsFromEnvelope('scout', envelope)) store.recordClaim(SESSION, entry)

    const output = render(store.describeClaims(SESSION))
    expect(output).toContain('Scout — "the resolver discards the ranked order')
    expect(output).toContain('the reference alone, which is a location and not a result')
  })
})
