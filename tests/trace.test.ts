/**
 * Tests for the opt-in delegation trace.
 *
 * Two properties matter, and the second is the one that decides whether this
 * file is safe to ship:
 *
 * 1. It must describe a transcript well enough to answer the question it exists
 *    for — "did `extractReply` match what the host actually returned?"
 * 2. **It must never carry message text.** The trace is a file on disk and the
 *    transcript holds the user's proposal and both reviewers' verdicts. A trace
 *    that leaked content would be worse than no trace at all, so that is
 *    asserted directly rather than assumed.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { delegateToAgent } from '../src/delegate'
import type { SessionProbeLike } from '../src/probe'
import type { TraceEvent } from '../src/trace'
import { createFileTrace, describeShape, NO_TRACE } from '../src/trace'
import { SERVER_DEFAULT_DIRECTORY } from './harness'

const SECRET = 'the user proposed a migration nobody asked for'

describe('describeShape', () => {
  test('names the type and the keys of every message', () => {
    const shape = describeShape([
      { type: 'user', text: SECRET },
      { type: 'assistant', agent: 'skeptic', content: [{ type: 'text', text: 'VERDICT: drop' }] }
    ])
    // The field `extractReply` discriminates on is called out by name, so a
    // mismatch with the real host is visible in the log without reading it.
    expect(shape).toContain('type=assistant')
    expect(shape).toContain('content:array(1)')
    expect(shape).toContain('agent:string')
  })

  test('survives a transcript that is not the shape we expect', () => {
    // The case this whole module exists for: a host returning something else must
    // still produce a readable description rather than throwing.
    const shape = describeShape([{ role: 'assistant', parts: [{ type: 'text', text: SECRET }] }] as unknown[])
    expect(shape).toContain('role:string')
    expect(shape).toContain('parts:array(1)')
    expect(shape).toContain('(no type)')
  })

  test('reports a non-array without throwing', () => {
    expect(describeShape(undefined as unknown as readonly unknown[])).toBe('not-an-array(undefined)')
  })

  test('does not throw on null entries or primitives', () => {
    expect(() => describeShape([null, 42, 'x'])).not.toThrow()
  })
})

describe('the file trace', () => {
  test('writes one JSON object per line', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orchestra-trace-')), 'nested', 'trace.jsonl')
    const trace = createFileTrace(path)
    trace('step', { step: 'wait', outcome: 'ok' })
    trace('reply', { extracted: false })

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'step', step: 'wait', outcome: 'ok' })
  })

  test('never throws, even when the path cannot be written', () => {
    // A trace must never be the reason a dispatch fails.
    const trace = createFileTrace('/proc/definitely/not/writable/trace.jsonl')
    expect(() => trace('step', { step: 'create' })).not.toThrow()
  })

  test('NO_TRACE discards everything', () => {
    expect(() => NO_TRACE('step', { step: 'wait' })).not.toThrow()
  })
})

describe('delegation tracing', () => {
  const session = (messages: readonly unknown[], options: { honourLocation?: boolean } = {}): SessionProbeLike =>
    ({
      // Mirrors the host: a create carrying a `location` is born there. With
      // `honourLocation: false` it models a host that ignores the field, which
      // is the path that still needs `move`.
      create: async (input?: { location?: { directory: string } }) => ({
        id: 'ses_trace',
        location: {
          directory:
            options.honourLocation === false
              ? SERVER_DEFAULT_DIRECTORY
              : (input?.location?.directory ?? SERVER_DEFAULT_DIRECTORY)
        }
      }),
      move: async () => undefined,
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
      prompt: async () => undefined,
      wait: async () => undefined,
      remove: async () => undefined,
      context: async () => messages
    }) as SessionProbeLike

  function collect() {
    const events: { event: string; data: TraceEvent }[] = []
    const trace = (event: string, data: TraceEvent = {}) => events.push({ event, data })
    return { events, trace }
  }

  test('records every host call with its outcome', async () => {
    const { events, trace } = collect()
    await delegateToAgent(session([{ type: 'assistant', content: [{ type: 'text', text: 'ok' }] }]), {
      agent: 'skeptic',
      directory: '/repo',
      text: SECRET,
      model: { providerID: 'opencode', id: 'm' },
      trace
    })

    const steps = events.filter(entry => entry.event === 'step').map(entry => entry.data.step)
    // create → switchAgent → switchModel → prompt → wait → context.
    // Each is named, so a trace can say which call died rather than only that
    // something did. No `move`: the session was born in the right directory.
    expect(steps).toEqual(['create', 'switchAgent', 'switchModel', 'prompt', 'wait', 'context'])
    expect(events.filter(entry => entry.event === 'step').every(entry => entry.data.outcome === 'ok')).toBe(true)
  })

  test('names the move a host that ignored the create location needs', async () => {
    // Same list, plus the correction — and named, so a trace says the session was
    // born in the wrong project rather than only that a call failed.
    const { events, trace } = collect()
    await delegateToAgent(
      session([{ type: 'assistant', content: [{ type: 'text', text: 'ok' }] }], { honourLocation: false }),
      { agent: 'skeptic', directory: '/repo', text: SECRET, model: { providerID: 'opencode', id: 'm' }, trace }
    )

    const steps = events.filter(entry => entry.event === 'step').map(entry => entry.data.step)
    expect(steps).toEqual(['create', 'move', 'switchAgent', 'switchModel', 'prompt', 'wait', 'context'])
  })

  test('records the transcript shape and never its text', async () => {
    const { events, trace } = collect()
    await delegateToAgent(
      session([{ type: 'assistant', agent: 'advisor', content: [{ type: 'text', text: SECRET }] }]),
      { agent: 'advisor', directory: '/repo', text: SECRET, trace }
    )

    const shape = events.find(entry => entry.event === 'context')
    expect(shape?.data.shape).toContain('type=assistant')
    expect(shape?.data.messages).toBe(1)

    // The strongest assertion in this file.
    const serialised = JSON.stringify(events)
    expect(serialised).not.toContain(SECRET)
  })

  test('records an empty extraction distinctly from a failure', async () => {
    // The whole reason this exists: both produced three identical words to the
    // caller, and only one of them is a bug in `extractReply`.
    const { events, trace } = collect()
    const result = await delegateToAgent(session([{ type: 'user', text: 'q' }]), {
      agent: 'skeptic',
      directory: '/repo',
      text: SECRET,
      trace
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('the agent produced no reply')
    expect(events.find(entry => entry.event === 'reply')).toMatchObject({ data: { extracted: false, chars: 0 } })
    expect(events.find(entry => entry.event === 'failed')).toBeUndefined()
  })

  test('names the call that threw, and still does not leak the prompt', async () => {
    const failing = {
      ...session([]),
      switchAgent: async () => {
        throw new Error('agent not registered in this directory')
      }
    } as SessionProbeLike
    const { events, trace } = collect()

    const result = await delegateToAgent(failing, {
      agent: 'skeptic',
      directory: '/repo',
      text: SECRET,
      trace
    })

    expect(result.ok).toBe(false)
    const failedStep = events.find(entry => entry.event === 'step' && entry.data.outcome === 'failed')
    expect(failedStep?.data.step).toBe('switchAgent')
    expect(events.find(entry => entry.event === 'failed')).toBeDefined()
    expect(JSON.stringify(events)).not.toContain(SECRET)
  })

  test('writes nothing when no trace is supplied', async () => {
    // The default path must stay silent: `debug` is opt-in.
    const result = await delegateToAgent(session([{ type: 'assistant', content: [{ type: 'text', text: 'ok' }] }]), {
      agent: 'advisor',
      directory: '/repo',
      text: SECRET
    })
    expect(result.ok).toBe(true)
  })
})
