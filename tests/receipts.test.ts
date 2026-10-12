/**
 * Delegation receipts and durable state across compaction.
 *
 * The gap this closes is silence, not data loss. When a scout's findings die at
 * compaction, from outside the session nothing distinguishes that from "scout
 * found nothing", and the builder concludes the search came back empty. A
 * receipt makes the loss say something.
 *
 * The tests are mostly negative on purpose. The load-bearing property is not
 * "a receipt is injected" — it is that an **`uncertain` receipt never reads as
 * completion**. A receipt store that flattened "the turn was killed" into
 * "failed" would look identical to this plugin from the outside and would be
 * strictly worse than no store, because it would tell the builder there was
 * nothing there when in fact nobody knows.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import plugin from '../index'
import type { PluginDefinitionLike } from '../src/plugin-types'
import { isUnclearOutcome, RECEIPT_CAP, ReceiptStore } from '../src/receipts'
import { model } from './fixture'
import type { PluginHarness, PluginHarnessOptions } from './harness'
import { createPluginHarness } from './harness'

const entry = plugin as PluginDefinitionLike

const MODELS = [
  model('tier-one', 1, 5),
  model('tier-two', 2, 10),
  model('tier-three', 3, 15),
  model('tier-four', 15, 75)
]
/** Pin the heavy roles so `scout` takes the cheapest model */
const PINNED = { roles: { advisor: 'anthropic/tier-four', builder: 'anthropic/tier-three' } }

const REFUSAL = "OpenCode's free tier can only be used from within OpenCode"
/** A genuine task fault: the work is broken, so no model would answer it. */
const TASK_ERROR = 'bun test: 3 tests failed. Expected 2 to be 3'
/** What a killed mid-flight turn leaves behind. */
const TIMEOUT = 'timed out after 300000ms while waiting for a reply'

let harness: PluginHarness | undefined
let teardown: undefined | (() => void)

async function loaded(
  options: PluginHarnessOptions = {},
  pluginOptions: Record<string, unknown> = PINNED
): Promise<PluginHarness> {
  const created = createPluginHarness({ models: MODELS, options: pluginOptions, ...options })
  harness = created
  teardown = await entry.setup(created.ctx)
  await created.settle()
  return created
}

/** The builder session the receipt tests delegate from. */
const SESSION = 'ses_b'

/** Delegates a question and returns the tool's own reply. */
async function scout(created: PluginHarness, text: string, sessionID = SESSION) {
  return created.callTool<{ content: { text: string }[]; isError?: boolean }>(
    'orchestra_scout',
    { text },
    { sessionID }
  )
}

/** Fires the context hook the way the host does, and returns what it injected. */
async function inject(
  created: PluginHarness,
  sessionID: string,
  messages: readonly unknown[] = [],
  kind?: 'compaction'
) {
  const event = created.contextEvent(sessionID, messages, kind)
  await created.fireSessionContext(event)
  await created.settle()
  return created.systemText(event).join('\n')
}

afterEach(async () => {
  if (typeof teardown === 'function') await teardown()
  await harness?.disposeAll()
  teardown = undefined
  harness = undefined
})

describe('a receipt is recorded', () => {
  test('a successful delegation leaves one naming the role, question and reply', async () => {
    const created = await loaded()
    created.sessionReplies['where is X?'] = 'src/a.ts:12 is the definition'

    const result = await scout(created, 'where is X?')
    expect(result.isError).toBeUndefined()

    const injected = await inject(created, SESSION)
    expect(injected).toContain('scout')
    expect(injected).toContain('DELIVERED')
    expect(injected).toContain('where is X?')
    expect(injected).toContain('src/a.ts:12 is the definition')
  })

  test('a failed dispatch records failure, not success', async () => {
    const created = await loaded()
    // A task-shaped failure, so the chain does not walk onto another model and
    // the receipt describes the dispatch that actually ended.
    created.delegateFailures['anthropic/tier-one'] = TASK_ERROR

    const result = await scout(created, 'where is X?')
    expect(result.isError).toBe(true)

    const injected = await inject(created, SESSION)
    // The dispatch produced nothing. That is a different fact from "an answer is
    // missing", and conflating them is the bug this guards.
    expect(injected).toContain('FAILED')
    expect(injected).toContain(TASK_ERROR)
    expect(injected).not.toContain('DELIVERED')
    expect(injected).not.toContain('UNCERTAIN')
  })

  test('a dispatch that failed on one model and answered on another is delivered', async () => {
    const created = await loaded()
    created.delegateFailures['anthropic/tier-one'] = REFUSAL
    created.sessionReplies['where is X?'] = 'src/a.ts:12 is the definition'

    const result = await scout(created, 'where is X?')
    expect(result.isError).toBeUndefined()

    // The receipt describes the dispatch as a whole, not its worst moment. The
    // refusal is still visible in the report — but the builder has an answer,
    // and a receipt claiming otherwise would send it looking for work it has.
    const injected = await inject(created, SESSION)
    expect(injected).toContain('DELIVERED')
    expect(injected).toContain('src/a.ts:12 is the definition')
  })

  test('a receipt names the model it last ran on, without repeating the blame', async () => {
    const created = await loaded()
    created.delegateFailures['anthropic/tier-one'] = REFUSAL
    created.delegateFailures['anthropic/tier-two'] = REFUSAL

    await scout(created, 'where is X?')
    const injected = await inject(created, SESSION)

    // The chain walked twice and stopped on the second model. Which one is the
    // only part the error text does not already say, so only that is named.
    expect(injected).toContain('on `anthropic/tier-two`')
    expect(injected).not.toContain('on `anthropic/tier-one`')
  })

  test('a reply that never came is not written as a result either', async () => {
    const created = await loaded()
    // No reply registered, so the delegation ends with "the agent produced no
    // reply". Still a failure: there is a definite answer that nothing came back.
    const result = await scout(created, 'where is X?')
    expect(result.isError).toBe(true)
    expect(await inject(created, SESSION)).toContain('FAILED')
  })
})

describe('the uncertain status', () => {
  test('a turn killed mid-flight records "uncertain", never "done"', async () => {
    const created = await loaded({}, { ...PINNED, delegateTimeoutMs: 20 })
    created.delegateHangs['anthropic/tier-one'] = true

    const result = await scout(created, 'where is X?')
    // The tool call reports a failure to its caller — it has to, there is no
    // reply to return. What matters is what the *receipt* claims afterwards.
    expect(result.isError).toBe(true)

    const injected = await inject(created, SESSION)
    expect(injected).toContain('UNCERTAIN')
    expect(injected).not.toContain('DELIVERED')
    expect(injected).not.toContain('FAILED')
    // Said in the builder's terms, not only in a status token: the whole point
    // is that the injected text cannot be misread as completion.
    expect(injected).toContain('not a result')
    expect(injected).toContain('do not rely on it')
  })

  test('the four statuses render as four different things', async () => {
    const store = new ReceiptStore()

    const answered = store.begin('s', 'scout', 'q1')
    store.settle('s', answered.id, { ok: true, text: 'an answer worth having here' })
    const refused = store.begin('s', 'scout', 'q2')
    store.settle('s', refused.id, { ok: false, error: REFUSAL })
    const killed = store.begin('s', 'advisor', 'q3')
    store.settle('s', killed.id, { ok: false, error: TIMEOUT })
    const broken = store.begin('s', 'builder', 'q4')
    store.settle('s', broken.id, { ok: false, error: 'agent not registered in this directory' })

    const block = store.injection('s')!
    const lines = block.split('\n').filter(line => line.startsWith('- '))
    expect(lines).toHaveLength(4)
    // Distinct in the status token *and* in what it tells the builder to do.
    expect(lines[0]).toContain('DELIVERED')
    expect(lines[1]).toContain('REFUSED')
    expect(lines[2]).toContain('UNCERTAIN')
    expect(lines[3]).toContain('FAILED')
    // A refusal is the one that must not read as "nothing to find": the work
    // was never run, so the conclusion is not available either way.
    expect(lines[1]).toContain('the work was never run')
    expect(lines[1]).not.toContain('not a result')
    expect(lines.filter(line => line.includes('not a result'))).toHaveLength(1)
  })

  test('a refused receipt survives persistence as refused', async () => {
    // The persisted shape check is a separate gate from the renderer, and a
    // status accepted by one but dropped by the other would reappear as a
    // failure to the builder after a restart.
    const store = new ReceiptStore()
    const receipt = store.begin('s', 'scout', 'q')
    store.settle('s', receipt.id, { ok: false, error: REFUSAL })
    const restored = new ReceiptStore()
    restored.restore(store.snapshot())
    expect(restored.unconsumed('s')[0]?.status).toBe('refused')
  })

  test('a status the dispatcher already decided is not re-derived', async () => {
    // The classification happens once, at the dispatch. If settle re-read the
    // message it could disagree with the delegate that produced it, and the
    // receipt would describe a different turn from the one that failed.
    const store = new ReceiptStore()
    const receipt = store.begin('s', 'scout', 'q')
    store.settle('s', receipt.id, { ok: false, status: 'refused', error: 'a message no classifier would read as a refusal' })
    expect(store.unconsumed('s')[0]?.status).toBe('refused')
  })

  test('a delivered verdict with no reply is not an answer', async () => {
    // Nothing to read means nothing delivered. Without this the receipt would
    // render DELIVERED with an empty reply, which is the one rendering the
    // builder cannot recover from.
    const store = new ReceiptStore()
    const receipt = store.begin('s', 'scout', 'q')
    store.settle('s', receipt.id, { ok: true, status: 'delivered' })
    const settled = store.unconsumed('s')[0]
    expect(settled?.status).toBe('failed')
    expect(store.injection('s')).not.toContain('DELIVERED')
  })

  test('a reply with no status is still delivered', async () => {
    // The negative control for the case above: defaulting on `ok` alone must not
    // start failing callers that never learned about the status field.
    const store = new ReceiptStore()
    const receipt = store.begin('s', 'scout', 'q')
    store.settle('s', receipt.id, { ok: true, text: 'an answer' })
    expect(store.unconsumed('s')[0]?.status).toBe('delivered')
  })

  test('a dispatch that never settles is uncertain, not pending-and-silent', async () => {
    const store = new ReceiptStore()
    // Opened and never settled: the crash / restart / lost-process case. The
    // only honest description is that nobody observed an outcome.
    store.begin('s', 'scout', 'where is X?')

    const block = store.injection('s')!
    expect(block).toContain('UNCERTAIN')
    expect(block).toContain('outcome never observed')
    expect(block).not.toContain('DELIVERED')
  })

  test('an eviction cannot turn into a claim of completion', () => {
    const store = new ReceiptStore({ perSession: 2 })
    const first = store.begin('s', 'scout', 'q1')
    store.settle('s', first.id, { ok: true, text: 'a first answer long enough to match' })
    store.begin('s', 'scout', 'q2')
    store.begin('s', 'scout', 'q3')

    // The settled receipt is gone; settling it afterwards finds nothing to
    // update, so the store cannot hold a record it no longer has.
    expect(store.settle('s', first.id, { ok: false, error: TIMEOUT })).toBeUndefined()
    expect(store.list('s').map(receipt => receipt.question)).toEqual(['q2', 'q3'])
  })

  test('isUnclearOutcome separates a killed run from a provider refusal', () => {
    for (const error of [
      TIMEOUT,
      'timed out after 200ms while prompting',
      'the request was aborted by the user',
      'run cancelled',
      'socket hang up'
    ]) {
      expect(isUnclearOutcome(error)).toBe(true)
    }
    // A refusal is a definite answer about the model: nothing came back, and
    // nobody is waiting to find out. Calling it uncertain would make a model
    // that reliably refuses look like bad luck.
    for (const error of [REFUSAL, 'the agent produced no reply', 'bun test: 3 tests failed', undefined, '']) {
      expect(isUnclearOutcome(error)).toBe(false)
    }
  })
})

describe('receipts are bounded', () => {
  test('the oldest are dropped past the cap, newest kept', async () => {
    const created = await loaded()
    for (let index = 0; index < RECEIPT_CAP + 3; index++) {
      const question = `question number ${index} with enough text to be identifiable`
      created.sessionReplies[question] = `reply number ${index} with enough text to be identifiable`
      await scout(created, question)
    }

    const injected = await inject(created, SESSION)
    expect(injected).toContain(`question number ${RECEIPT_CAP + 2}`)
    expect(injected).not.toContain('question number 0 ')
    expect(injected).not.toContain('question number 1 ')
  })

  test('a count that fits the line budget but not the per-turn budget is still cut', () => {
    const store = new ReceiptStore()
    // Short receipts, so the character budget is never the binding constraint
    // and the only thing that can hold the block back is the per-turn count.
    for (let index = 0; index < 9; index++) {
      const receipt = store.begin('s', 'scout', `q${index}`)
      store.settle('s', receipt.id, { ok: true, text: `a${index}` })
    }

    const block = store.injection('s')!
    const lines = block.split('\n').filter(line => line.startsWith('- '))
    expect(lines.length).toBeLessThan(9)
    expect(block).toContain('9 delegation(s)')
    expect(block).toContain('not shown')
  })

  test('the cap holds per session, not in total', () => {
    const store = new ReceiptStore({ perSession: 3 })
    for (const sessionID of ['a', 'b']) {
      for (const question of ['q1', 'q2', 'q3', 'q4']) store.begin(sessionID, 'scout', question)
    }
    expect(store.list('a')).toHaveLength(3)
    expect(store.list('b')).toHaveLength(3)
    expect(store.list('a')[0]!.question).toBe('q2')
  })

  test('the injected block is bounded even when every receipt is unconsumed', () => {
    const store = new ReceiptStore({ perSession: 50 })
    for (let index = 0; index < 40; index++) {
      const receipt = store.begin('s', 'scout', `question ${index} `.repeat(30))
      store.settle('s', receipt.id, { ok: true, text: `reply ${index} `.repeat(60).trim() })
    }

    const block = store.injection('s')!
    // Bounded, not empty, and not silently short: the header has to admit the
    // rest are hidden, or a builder reading two lines would think two
    // delegations ever happened.
    expect(block.length).toBeLessThan(1600)
    expect(block).toContain('40 delegation(s)')
    expect(block).toContain('not shown')
    // Newest wins the budget, oldest is what gets dropped.
    expect(block).toContain('question 39')
    expect(block).not.toContain('question 0 ')
  })

  test('a session untouched for longer than the TTL is forgotten', () => {
    let clock = 1_000
    const store = new ReceiptStore({ ttlMs: 60_000, now: () => clock })
    store.begin('s', 'scout', 'where is X?')
    clock += 30_000
    expect(store.prune()).toBe(0)
    clock += 40_000
    expect(store.prune()).toBe(1)
    expect(store.injection('s')).toBeUndefined()
  })

  test('a receipt used recently keeps its session alive past the TTL', () => {
    let clock = 1_000
    const store = new ReceiptStore({ ttlMs: 60_000, now: () => clock })
    const first = store.begin('s', 'scout', 'an older question worth holding on to')
    store.begin('s', 'scout', 'q2')
    clock += 80_000

    // The newest receipt is the older one being used: a session that just
    // consumed an answer is not idle, and forgetting it would drop a receipt
    // the builder is mid-way through acting on.
    store.settle('s', first.id, { ok: true, text: 'an answer long enough to be evidence' })
    expect(store.prune()).toBe(0)
    expect(store.injection('s')).toContain('an older question')
  })
})

describe('re-injection on the context hook', () => {
  test('an unconsumed receipt is offered on every turn until it is used', async () => {
    const created = await loaded()
    created.sessionReplies['where is X?'] = 'src/a.ts:12 is the definition'
    await scout(created, 'where is X?')

    // The builder's transcript is empty of the answer, so there is nothing to
    // say it has been consumed.
    expect(await inject(created, SESSION)).toContain('where is X?')
    expect(await inject(created, SESSION)).toContain('where is X?')
    expect(await inject(created, SESSION)).toContain('where is X?')
  })

  test('a CONSUMED receipt is not re-injected', async () => {
    const created = await loaded()
    const answer = 'src/a.ts:12 is the definition of the entry point'
    created.sessionReplies['where is X?'] = answer
    await scout(created, 'where is X?')

    // The delegation tool result is in the builder's transcript: the receipt has
    // done its job. Re-injecting it every turn would grow the block without end
    // and train the model to skip the line that mattered.
    const transcript = [{ type: 'tool', content: [{ type: 'text', text: answer }] }]
    const injected = await inject(created, SESSION, transcript)
    expect(injected).not.toContain(answer)
    expect(injected).not.toContain('delegation')
    // And it stays quiet afterwards, rather than coming back the next turn.
    expect(await inject(created, SESSION, transcript)).not.toContain(answer)
  })

  test('a receipt the reminder itself produced does not mark itself read', async () => {
    const store = new ReceiptStore()
    const receipt = store.begin('s', 'scout', 'where is X?')
    store.settle('s', receipt.id, { ok: true, text: 'an answer long enough to be evidence of itself' })

    // Feed the injected text back in as though the host had persisted it. If a
    // reminder counted as reading, the receipt would retire on the next turn and
    // a later compaction would lose it with nothing left to re-offer.
    const first = store.injection('s')!
    expect(store.noteTranscript('s', [{ type: 'system', text: first }])).toBe(0)
    expect(store.unconsumed('s')).toHaveLength(1)
    expect(store.injection('s')).toBe(first)
  })

  test('nothing is injected when nothing was delegated', async () => {
    const created = await loaded()
    expect(await inject(created, SESSION)).toBe('')
  })

  test('a receipt from another session is never injected', async () => {
    const created = await loaded()
    created.sessionReplies['where is X?'] = 'src/a.ts:12 is the definition'
    await scout(created, 'where is X?', 'ses_a')

    expect(await inject(created, SESSION)).toBe('')
    expect(await inject(created, 'ses_c')).toBe('')
    expect(await inject(created, 'ses_a')).toContain('where is X?')
  })

  test('a compaction re-opens a receipt the builder had already consumed', async () => {
    const created = await loaded()
    const answer = 'src/a.ts:12 is the definition of the entry point'
    created.sessionReplies['where is X?'] = answer
    await scout(created, 'where is X?')

    const transcript = [{ type: 'tool', content: [{ type: 'text', text: answer }] }]
    expect(await inject(created, SESSION, transcript)).not.toContain(answer)

    // The host fires the compaction hook for this turn. That is the one moment
    // an answer the builder genuinely had can be gone, so the receipt comes
    // back — the whole reason this module exists. (The context hook carries no
    // `kind` on the host — H2 — so a kind-flagged context event is not how a
    // real compaction arrives.)
    await created.fire('compaction', { sessionID: SESSION })
    await created.settle()
    expect(await inject(created, SESSION, [])).toContain('where is X?')
  })

  test('receipts survive a plugin reload through storage', async () => {
    const created = await loaded()
    created.sessionReplies['where is X?'] = 'src/a.ts:12 is the definition'
    await scout(created, 'where is X?')
    await created.settle()
    // A restart is the other half of "durable". The store is what is rehydrated,
    // so a receipt outlives the process that made it.
    expect(created.store.get('receipts')).toMatchObject({ version: 1 })
    const revived = await loaded({ storage: { receipts: created.store.get('receipts') } })
    expect(await inject(revived, SESSION)).toContain('where is X?')
  })

  test('a corrupt snapshot is dropped rather than half-restored', async () => {
    const corrupt = { version: 99, sessions: { [SESSION]: [{ id: 'x' }] } }
    const created = await loaded({ storage: { receipts: corrupt } })
    // A half-restored receipt would be re-injected as fact. Better to lose it.
    expect(await inject(created, SESSION)).toBe('')
  })

  test('injection can be turned off', async () => {
    const created = await loaded({}, { ...PINNED, receipts: false })
    created.sessionReplies['where is X?'] = 'src/a.ts:12 is the definition'
    await scout(created, 'where is X?')
    expect(await inject(created, SESSION)).toBe('')
  })
})

describe('truncation', () => {
  // Built with `String.repeat`, not a template literal: a template would embed
  // the *source text* of the call, which is 14 characters and tests nothing.
  const question = 'q'.repeat(900)
  const reply = 'r'.repeat(4000)

  test('the stored question and reply are cut, and the cut is stated', async () => {
    const store = new ReceiptStore()
    const receipt = store.begin('s', 'scout', question)
    store.settle('s', receipt.id, { ok: true, text: reply })

    const stored = store.list('s')[0]!
    expect(stored.question.length).toBeLessThan(question.length)
    expect(stored.reply!.length).toBeLessThan(reply.length)
    expect(stored.cut).toContain('question')
    expect(stored.cut).toContain('reply')

    // The rendered line says so too. A truncated excerpt that reads as a whole
    // one is worse than no receipt, because the builder will cite it.
    const line = store.injection('s')!
    expect(line).toContain('reply (truncated)')
    expect(line).not.toContain(reply)
  })

  test('a short reply is not marked truncated', () => {
    const store = new ReceiptStore()
    const receipt = store.begin('s', 'scout', 'where is X?')
    store.settle('s', receipt.id, { ok: true, text: 'src/a.ts:12' })

    expect(store.list('s')[0]!.cut).toEqual([])
    expect(store.injection('s')).toContain('reply: src/a.ts:12')
    expect(store.injection('s')).not.toContain('truncated')
  })

  test('a receipt survives a long question end to end through the plugin', async () => {
    const created = await loaded()
    created.sessionReplies[question] = reply
    await scout(created, question)

    const injected = await inject(created, SESSION)
    expect(injected).toContain('reply (truncated)')
    expect(injected.length).toBeLessThan(1000)
  })
})

describe('receipts without session.context', () => {
  test('two context fires still offer the receipt on the second turn', async () => {
    const created = await loaded({ omit: ['session.context'] })
    created.sessionReplies['where is X?'] = 'src/a.ts:12 is the definition'
    await scout(created, 'where is X?')

    // The reply is not in either transcript, so the receipt stays pending and
    // both turns must offer it. Before the guard, a missing `session.context`
    // threw synchronously past the `.finally` that clears the usage guard, so
    // the second firing short-circuited and the receipt went silent.
    expect(await inject(created, SESSION, [])).toContain('where is X?')
    expect(await inject(created, SESSION, [])).toContain('where is X?')
  })
})

describe('a reply that adds nothing to the question is not a consumption', () => {
  // The builder's transcript has contained the QUESTION since the moment the
  // tool call was recorded. So a reply that merely quotes the question back
  // matches text that was there before any answer existed, and retiring the
  // receipt on it leaves a later compaction with nothing to re-offer.
  const question = 'please locate every file that handles token refresh for the authentication flow in this project'
  const echoed = 'locate every file that handles token refresh for the authentication flow'

  function settled(reply: string, ask = question) {
    const store = new ReceiptStore()
    const receipt = store.begin('s', 'scout', ask)
    store.settle('s', receipt.id, { ok: true, text: reply })
    return store
  }

  test('the tool call alone does not consume the receipt', () => {
    const store = settled(echoed)
    // Only the question is present — the delegation tool's input.
    expect(store.noteTranscript('s', [{ type: 'tool', input: { text: question } }])).toBe(0)
    expect(store.unconsumed('s')).toHaveLength(1)
  })

  test('a reply longer than the question still consumes', () => {
    // The guard is "added nothing", not "shares words with the question": a
    // real answer quotes the question and says more, and must still retire.
    const store = settled(`${echoed} — src/auth/refresh.ts:44`)
    expect(
      store.noteTranscript('s', [
        { type: 'tool', content: [{ type: 'text', text: `${echoed} — src/auth/refresh.ts:44` }] }
      ])
    ).toBe(1)
    expect(store.unconsumed('s')).toHaveLength(0)
  })

  test('a receipt with no recorded question is not rejected outright', () => {
    // `question.includes(needle)` is vacuously true for an empty question, so a
    // naive guard would silently stop every receipt from ever being consumed.
    const store = settled('src/auth/refresh.ts:44 handles the rotation', '')
    expect(
      store.noteTranscript('s', [
        { type: 'tool', content: [{ type: 'text', text: 'src/auth/refresh.ts:44 handles the rotation' }] }
      ])
    ).toBe(1)
  })

  test('the match is whitespace- and case-insensitive, as the question is', () => {
    const store = settled('Locate   every file that handles token refresh for the authentication flow')
    expect(store.noteTranscript('s', [{ type: 'tool', input: { text: question } }])).toBe(0)
  })

  test('a reply too short to be evidence does not consume, whatever the floor', () => {
    // The floor is a mitigation, not a fix, and it had no test at all: removing
    // it reddened nothing, which is exactly how a mitigation disappears as a
    // "cleanup". A two-character reply matches somewhere in any transcript.
    //
    // No recorded question, because that is the only case the floor still
    // decides: with one, the "added nothing" guard above catches a short reply
    // on its own. With none there is nothing to be a subset of, so the floor is
    // all that stands between `ok` and a retired receipt.
    const store = settled('ok', '')
    expect(store.noteTranscript('s', [{ type: 'assistant', content: [{ type: 'text', text: 'ok' }] }])).toBe(0)
    expect(store.unconsumed('s')).toHaveLength(1)
  })
})
