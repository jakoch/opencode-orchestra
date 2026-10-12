/**
 * Delegating over an ordinary session: the host's built-in subagent launch is
 * refused on free-tier credentials, so the same agent is run through a normal
 * session — permissions and all, not a way around them.
 */

import { isDelivered, type OutcomeStatus, outcomeFor } from './outcome'
import type { SessionProbeLike } from './probe'
import { describeShape, NO_TRACE, type Trace } from './trace'

export interface DelegationInput {
  /** The agent to run, e.g. `scout` or `advisor`. */
  agent: string
  /**
   * Required in practice, and applied at **create** time.
   *
   * With no location the session is born in the *server's* default directory,
   * where project agents are not registered — so `switchAgent` fails silently and
   * the turn ends `idle: failed` with no error to explain it. Prompting it also
   * boots a second location on the server for that directory: a phantom workspace
   * left behind after the session is removed. See `session.create`.
   */
  directory: string
  /** The question or instruction, verbatim. */
  text: string
  model?: { providerID: string; id: string; variant?: string }
  timeoutMs?: number
  /** Called with the id of the session opened, so a failure inside it is tellable from one elsewhere. */
  onSession?: (sessionID: string) => void
  /**
   * Opt-in trace of this one attempt. Defaults to discarding everything, so a
   * caller without `debug: true` pays nothing and writes nothing.
   */
  trace?: Trace
}

/**
 * What came back, or why nothing did.
 *
 * `status` is the decision; `ok` is a view over it, kept because most call sites
 * only need "is there an answer". The distinction `ok` cannot express —
 * refused, uncertain, or failed — is the point of the shared contract: a caller
 * deciding whether to retry or to believe the silence used to re-classify the
 * error string here, and could disagree with the receipt built from it.
 */
export interface DelegationResult {
  status: OutcomeStatus
  ok: boolean
  text?: string
  error?: string
  elapsedMs: number
}

/** Builds a result, deriving `ok` from the one status rather than deciding twice. */
export function result(
  status: OutcomeStatus,
  body: { text?: string; error?: string; elapsedMs: number }
): DelegationResult {
  return { status, ok: isDelivered(status), ...body }
}

const DEFAULT_DELEGATION_TIMEOUT_MS = 300_000

/**
 * Only `type: "text"` items count — `reasoning` carries `text` too. An earlier
 * version guessed at `role`/`parts`, matched nothing, and reported a working
 * agent as silent.
 */
export function extractReply(messages: readonly unknown[]): string | undefined {
  const parts: string[] = []
  for (const message of messages) {
    const record = message as { type?: string; content?: unknown[] }
    if (record?.type !== 'assistant' || !Array.isArray(record.content)) continue
    for (const item of record.content) {
      const typed = item as { type?: string; text?: string }
      if (typed?.type !== 'text') continue
      if (typeof typed.text === 'string' && typed.text.trim()) parts.push(typed.text.trim())
    }
  }
  const joined = parts.join('\n').trim()
  return joined || undefined
}

/**
 * The error a turn ended with, when it ended with one.
 *
 * A refused provider call leaves an `assistant` message with empty `content` and a
 * populated `error`. `extractReply` correctly finds no reply there — and the
 * reason was then thrown away, so every refusal was reported as "the agent
 * produced no reply". That reads as a bug in this plugin and sends the reader
 * looking in the wrong place, when the provider had already said what was wrong.
 *
 * Read from the transcript, not from `wait`: that does not throw for a refused
 * turn, so by the time the delegation returns this message is the only record
 * that anything went wrong.
 */
export function extractFailure(messages: readonly unknown[]): string | undefined {
  for (const message of messages) {
    const record = message as { type?: string; error?: unknown }
    if (record?.type !== 'assistant') continue
    const described = describeError(record.error)
    if (described) return described
  }
  return undefined
}

/** `AI.Error.Authentication: <message>`, however the host happens to shape it. */
function describeError(error: unknown, depth = 0): string | undefined {
  if (!error) return undefined
  if (typeof error === 'string') return error.trim() || undefined
  if (typeof error !== 'object') return undefined
  const record = error as {
    type?: unknown
    name?: unknown
    message?: unknown
    error?: unknown
    data?: unknown
    cause?: unknown
  }
  const label = [record.type, record.name].find(
    (value): value is string => typeof value === 'string' && Boolean(value.trim())
  )
  const message = typeof record.message === 'string' && record.message.trim() ? record.message.trim() : undefined
  if (message) return label ? `${label}: ${message}` : message
  // One level in, because the host has wrapped this more than one way and a shape
  // this does not recognise means the reason is silently dropped again — the
  // exact failure this function exists to end. Depth-limited so a self-referential
  // error cannot walk forever.
  if (depth < 1) {
    for (const nested of [record.error, record.data, record.cause]) {
      const described = describeError(nested, depth + 1)
      if (described) return described
    }
  }
  // A label with no message still says which layer refused.
  return label
}

/**
 * Key names of any error objects in the transcript, for the trace.
 *
 * Shapes, never values. Read only when nothing was extracted, so the next run
 * says *why* the reason could not be read instead of leaving the same silence to
 * be debugged twice.
 */
export function describeErrorShape(messages: readonly unknown[]): string | null {
  const shapes: string[] = []
  for (const message of messages) {
    const record = message as { type?: string; error?: unknown }
    if (record?.type !== 'assistant' || !record.error) continue
    if (typeof record.error !== 'object') {
      shapes.push(`error:${typeof record.error}`)
      continue
    }
    const fields = record.error as Record<string, unknown>
    shapes.push(
      Object.keys(fields)
        .sort()
        .map(key => `${key}:${typeof fields[key]}`)
        .join(',')
    )
  }
  return shapes.length ? shapes.join(' | ') : null
}

/** Runs one agent over a session and returns its reply. */
export async function delegateToAgent(
  session: SessionProbeLike,
  input: DelegationInput,
  now: () => number = Date.now
): Promise<DelegationResult> {
  const started = now()
  const timeoutMs = input.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS
  const trace = input.trace ?? NO_TRACE
  let sessionID: string | undefined

  // `step` wraps every awaited host call so a throw is recorded against the
  // operation that caused it. The session API swallows failures into an
  // `idle: failed` turn rather than rejecting, which is why the boundaries here
  // need naming individually: without them a trace cannot say whether the turn
  // died before admission or after it.
  const step = async <T>(label: string, work: Promise<T>): Promise<T> => {
    const at = now() - started
    try {
      const value = await withTimeout(work, timeoutMs, label)
      trace('step', { step: label, outcome: 'ok', ms: at })
      return value
    } catch (error) {
      trace('step', { step: label, outcome: 'failed', ms: at, error: String(error).slice(0, 120) })
      throw error
    }
  }

  try {
    const created = await step(
      'create',
      session.create({ title: `orchestra: ${input.agent}`, location: { directory: input.directory } })
    )
    sessionID = created.id
    input.onSession?.(sessionID)
    trace('session', { agent: input.agent, model: input.model ? `${input.model.providerID}/${input.model.id}` : null })

    // Before any agent switch: agents are registered per directory. Only needed
    // when the host ignored `create({ location })` — a host that placed the
    // session correctly is left alone rather than moved to where it already is.
    if (created.location?.directory !== input.directory) {
      await step('move', session.move({ sessionID, directory: input.directory }))
    }

    // switchAgent installs the agent's own permissions, so the session cannot
    // become a way to run an agent outside its rules.
    await step('switchAgent', session.switchAgent({ sessionID, agent: input.agent }))
    if (input.model) {
      // A session's own model beats the agent's, so it must be set explicitly.
      await step('switchModel', session.switchModel({ sessionID, model: input.model }))
    }

    await step('prompt', session.prompt({ sessionID, text: input.text, delivery: 'steer' }))
    // `prompt` returns on admission, not on answer.
    await step('wait', session.wait({ sessionID }))

    const messages = await step('context', session.context({ sessionID }))
    // Shape only: the key names answer "did `extractReply` match?", and the
    // values would put a proposal and two verdicts in a file.
    trace('context', { messages: Array.isArray(messages) ? messages.length : -1, shape: describeShape(messages) })

    const reply = extractReply(messages)
    // Only worth reading when there is no reply: a turn can carry both a warning
    // and an answer, and the answer is the outcome.
    const failure = reply ? undefined : extractFailure(messages)
    trace('reply', {
      extracted: Boolean(reply),
      chars: reply?.length ?? 0,
      error: failure?.slice(0, 120) ?? null,
      // Key names only, and only when the reason could not be read. This is the
      // difference between a fix that works and one that silently does not fire
      // because the host shaped its error object differently.
      errorShape: reply || failure ? null : describeErrorShape(messages),
      elapsedMs: now() - started
    })
    if (!reply) {
      // Classified once, here, so the receipt built from this result cannot
      // disagree with it about what happened.
      const error = failure ?? 'the agent produced no reply'
      return result(outcomeFor(error).status, { error, elapsedMs: now() - started })
    }
    return result('delivered', { text: reply, elapsedMs: now() - started })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    trace('failed', { error: message.slice(0, 200), elapsedMs: now() - started })
    return result(outcomeFor(message).status, { error: message.slice(0, 300), elapsedMs: now() - started })
  } finally {
    // Always, including the throwing paths: a leaked session shows in the user's
    // list as work in progress that nothing is doing.
    if (sessionID) await session.remove({ sessionID }).catch(() => undefined)
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms while ${what}`)), timeoutMs)
    work.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
