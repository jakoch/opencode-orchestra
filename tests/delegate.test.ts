/**
 * Session-backed delegation.
 *
 * This is the route that exists because the host's child-session launch is
 * refused outright on a free-tier credential. The tests that matter most are the
 * negative ones: a session must never be left behind, and a failure must never
 * masquerade as an answer.
 */

import { describe, expect, test } from 'bun:test'
import { delegateToAgent, extractReply } from '../src/delegate'
import type { SessionProbeLike } from '../src/probe'
import { SERVER_DEFAULT_DIRECTORY } from './harness'

/** A session double that records everything the delegation does to it. */
function fakeSession(
  options: {
    reply?: string
    failOn?: string
    hangOn?: string
    /** A turn that ended refused: an assistant message with no content and this error. */
    turnError?: unknown
  } = {}
) {
  const log: string[] = []
  let created: string | undefined
  const session = {
    create: async (input?: { title?: string; location?: { directory: string } }) => {
      created = `ses_${log.length}`
      log.push(`create:${input?.location?.directory ?? 'no-location'}`)
      return {
        id: created,
        location: { directory: input?.location?.directory ?? SERVER_DEFAULT_DIRECTORY }
      }
    },
    move: async (input: { directory: string }) => {
      log.push(`move:${input.directory}`)
    },
    switchAgent: async (input: { agent: string }) => {
      log.push(`switchAgent:${input.agent}`)
      if (options.failOn === 'switchAgent') throw new Error('free tier can only be used from within OpenCode')
    },
    switchModel: async () => {
      log.push('switchModel')
    },
    prompt: async () => {
      log.push('prompt')
      if (options.failOn === 'prompt') throw new Error('the agent did not answer')
    },
    wait: async () => {
      log.push('wait')
      if (options.hangOn === 'wait')
        return new Promise<void>(() => {
          /* never settles: this is the timeout path under test */
        })
    },
    remove: async () => {
      log.push('remove')
    },
    context: async () =>
      options.turnError
        ? [
            { type: 'user', text: 'q' },
            // Shaped like the real refusal: `content` empty, `error` set. Copied
            // from the host transcript rather than imagined.
            { type: 'assistant', agent: 'scout', content: [], error: options.turnError }
          ]
        : [
            { type: 'user', text: 'q' },
            {
              type: 'assistant',
              agent: 'scout',
              content: [
                { type: 'reasoning', text: 'should be ignored' },
                { type: 'tool', tool: 'read', state: { status: 'completed' } },
                { type: 'text', text: options.reply ?? 'the answer' }
              ]
            }
          ]
  }
  return { session: session as unknown as SessionProbeLike, log, id: () => created }
}

describe('extractReply', () => {
  test('returns assistant text and nothing else', () => {
    // Shaped like SessionMessageInfo: discriminated by `type`, content array.
    const messages = [
      { type: 'user', text: 'question' },
      {
        type: 'assistant',
        agent: 'scout',
        content: [
          { type: 'reasoning', text: 'internal' },
          { type: 'tool', tool: 'read', state: { status: 'completed' } },
          { type: 'text', text: 'src/a.ts:12 and src/b.ts:40' }
        ]
      }
    ]
    expect(extractReply(messages)).toBe('src/a.ts:12 and src/b.ts:40')
  })

  test('returns undefined when there is no assistant text', () => {
    expect(extractReply([{ type: 'user', text: 'q' }])).toBeUndefined()
    expect(extractReply([])).toBeUndefined()
  })
})

describe('delegateToAgent', () => {
  test('runs the agent and returns its reply', async () => {
    const { session } = fakeSession({ reply: 'found it' })
    const result = await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'where is X' })
    expect(result.ok).toBe(true)
    expect(result.text).toBe('found it')
  })

  test('opens the session in the project at create time, not after it', async () => {
    // The bug this exists for: a plugin-created session with no `location` is
    // born in the *server's* default directory — `/` for a service booted from
    // `/` — where project agents are not registered. Switching to `scout` there
    // produced no error and no reply: the turn just ended `idle: failed`, which
    // is indistinguishable from a model refusing.
    //
    // Moving afterwards is not equivalent. The session already exists in the
    // wrong project, and prompting one boots that location on the server — a
    // phantom workspace that outlives the session and is what the host's
    // `session.location-missing` dialog and its folder switcher trip over.
    const { session, log } = fakeSession()
    await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'q' })
    expect(log[0]).toBe('create:/repo')
    expect(log).not.toContain(`create:${SERVER_DEFAULT_DIRECTORY}`)
  })

  test('moves the session only when the host ignored the create location', async () => {
    const { session, log } = fakeSession()
    await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'q' })
    // Already in the right directory, so there is nothing to correct — and
    // `move` still precedes `switchAgent`, which is the ordering that matters.
    expect(log).not.toContain('move:/repo')
    expect(log.indexOf('switchAgent:scout')).toBeGreaterThan(log.indexOf('create:/repo'))
  })

  test('a host that drops the create location is corrected by move, before the agent switch', async () => {
    // The fallback, kept because `create({ location })` is a host feature and a
    // plugin cannot assume it. Losing it must not silently produce a session in
    // the wrong project.
    const { session, log } = fakeSession()
    const ignoring = {
      ...session,
      create: async () => ({ id: 'ses_x', location: { directory: SERVER_DEFAULT_DIRECTORY } })
    }
    await delegateToAgent(ignoring as SessionProbeLike, { agent: 'scout', directory: '/repo', text: 'q' })
    expect(log.indexOf('move:/repo')).toBeLessThan(log.indexOf('switchAgent:scout'))
  })

  test('switches to the requested agent before prompting', async () => {
    // The agent carries the prompt, permissions and model. Prompting before
    // switching would run the wrong agent entirely.
    const { session, log } = fakeSession()
    await delegateToAgent(session, { agent: 'advisor', directory: '/repo', text: 'review this' })
    expect(log.indexOf('switchAgent:advisor')).toBeLessThan(log.indexOf('prompt'))
  })

  test('waits for the turn to finish before reading the reply', async () => {
    const { session, log } = fakeSession()
    await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'q' })
    expect(log.indexOf('wait')).toBeLessThan(log.indexOf('remove'))
  })

  test('removes the session on success', async () => {
    const { session, log } = fakeSession()
    await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'q' })
    expect(log).toContain('remove')
  })

  test('removes the session even when the agent refuses', async () => {
    // A leaked session shows up in the user's list as work in progress that
    // nobody is doing, and nothing else would ever clean it up.
    const { session, log } = fakeSession({ failOn: 'switchAgent' })
    const result = await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'q' })
    expect(result.ok).toBe(false)
    expect(log).toContain('remove')
  })

  test('removes the session even when it hangs', async () => {
    const { session, log } = fakeSession({ hangOn: 'wait' })
    const result = await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'q', timeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('timed out')
    expect(log).toContain('remove')
  })

  test('reports a refusal without inventing a reply', async () => {
    const { session } = fakeSession({ failOn: 'prompt' })
    const result = await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'q' })
    expect(result.ok).toBe(false)
    expect(result.text).toBeUndefined()
    expect(result.error).toContain('did not answer')
  })

  test('the status says which of the three non-answers this was', async () => {
    // The reason the contract exists: `ok: false` collapsed a credential the
    // host would not serve, a turn that never returned, and a task that broke.
    // Each remediates differently, and the receipt built from this result has to
    // be able to tell them apart too.
    const refused = await delegateToAgent(fakeSession({ failOn: 'switchAgent' }).session, {
      agent: 'scout',
      directory: '/repo',
      text: 'q'
    })
    const hung = await delegateToAgent(fakeSession({ hangOn: 'wait' }).session, {
      agent: 'scout',
      directory: '/repo',
      text: 'q',
      timeoutMs: 20
    })
    const broken = await delegateToAgent(fakeSession({ failOn: 'prompt' }).session, {
      agent: 'scout',
      directory: '/repo',
      text: 'q'
    })

    expect(refused.status).toBe('refused')
    expect(hung.status).toBe('uncertain')
    expect(broken.status).toBe('failed')
    // `ok` is a view, not a second decision: it cannot disagree with the status.
    for (const r of [refused, hung, broken]) expect(r.ok).toBe(false)
  })

  test('a delivered turn is delivered by status too', async () => {
    const delivered = await delegateToAgent(fakeSession().session, { agent: 'scout', directory: '/repo', text: 'q' })
    expect(delivered.status).toBe('delivered')
    expect(delivered.ok).toBe(true)
  })

  test('an empty transcript is a failure, not a silent success', async () => {
    const session = {
      ...fakeSession().session,
      context: async () => [{ type: 'user', text: 'q' }]
    } as unknown as SessionProbeLike
    const result = await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'q' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no reply')
  })

  test('a refused turn reports what the provider said, not that the agent was silent', async () => {
    // The field bug this exists for: every refused delegation was reported as
    // "the agent produced no reply". The reason was sitting in the transcript the
    // whole time, on the assistant message, and nothing read it — so the report
    // named a symptom in this plugin instead of the cause at the provider.
    const { session } = fakeSession({
      turnError: {
        type: 'AI.Error.Authentication',
        message: "OpenCode's free tier can only be used from within OpenCode"
      }
    })
    const result = await delegateToAgent(session, { agent: 'skeptic', directory: '/repo', text: 'q' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('AI.Error.Authentication')
    expect(result.error).toContain('free tier')
    expect(result.error).not.toContain('no reply')
    // Still no reply invented out of the empty content.
    expect(result.text).toBeUndefined()
  })

  test('a reply is not overridden by a warning on the same message', async () => {
    // A turn can carry an answer and an error at once. The answer is the outcome;
    // reporting the error instead would discard a verdict that was produced.
    const session = {
      ...fakeSession({ reply: 'VERDICT: drop' }).session,
      context: async () => [
        {
          type: 'assistant',
          agent: 'skeptic',
          content: [{ type: 'text', text: 'VERDICT: drop' }],
          error: { type: 'AI.Error', message: 'a warning worth ignoring' }
        }
      ]
    } as unknown as SessionProbeLike
    const result = await delegateToAgent(session, { agent: 'skeptic', directory: '/repo', text: 'q' })

    expect(result.ok).toBe(true)
    expect(result.text).toBe('VERDICT: drop')
  })

  test('an error field with nothing readable in it still says no reply', async () => {
    const session = {
      ...fakeSession().session,
      context: async () => [{ type: 'assistant', agent: 'scout', content: [], error: { code: 500 } }]
    } as unknown as SessionProbeLike
    const result = await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'q' })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('the agent produced no reply')
  })

  test('reads a reason the host nested inside the error object', async () => {
    // The host wraps provider errors more than one way, and a shape this does not
    // recognise means the reason is dropped again — the failure this whole
    // function exists to end. One level of nesting is read for that reason.
    const { session } = fakeSession({
      turnError: {
        type: 'AI.Error.Authentication',
        data: { message: 'must be used from within OpenCode' }
      }
    })
    const result = await delegateToAgent(session, { agent: 'skeptic', directory: '/repo', text: 'q' })

    expect(result.error).toContain('must be used from within OpenCode')
    expect(result.error).not.toContain('no reply')
  })

  test('opens the delegated session at the directory it was given, with no parent', async () => {
    // The session is deliberately NOT opened as a child of the caller's.
    //
    // Passing `parentID` was tried and reverted: a child inherits its parent's
    // location, so a delegation issued while the user is in one workspace got
    // pinned to a directory the plugin does not control, and the host raised its
    // own `session.location-missing` recovery dialog with an unusable workspace
    // behind it. The location is the plugin's own, declared on the create.
    const { session, log } = fakeSession({ reply: 'found it' })

    await delegateToAgent(session, { agent: 'scout', directory: '/repo', text: 'q' })

    // No parent on the create, and born where it has to run.
    expect(log[0]).toBe('create:/repo')
    expect(log).not.toContain(`create:${SERVER_DEFAULT_DIRECTORY}`)
  })

  test('pins the model when one is given', async () => {
    const { session, log } = fakeSession()
    await delegateToAgent(session, {
      agent: 'scout',
      directory: '/repo',
      text: 'q',
      model: { providerID: 'opencode', id: 'some-model' }
    })
    expect(log).toContain('switchModel')
  })
})
