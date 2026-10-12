/**
 * Opt-in tracing for session-backed delegation.
 *
 * A delegation that produces nothing is indistinguishable from one that
 * produced an empty answer, and the plugin was reporting the second when it meant
 * the first. The observed failures came back in ~700ms — too fast for a model to
 * have answered — so the turn died at admission, but nothing recorded *where*.
 *
 * **Shapes, never content.** `describeShape` reports key names and value types of
 * a transcript and nothing else. The question is "what shape did
 * `session.context()` return", and the answer is a list of keys. Writing a
 * proposal or a verdict into a file would be a far worse trade.
 *
 * Off unless `debug: true`. A plugin should not write files unasked.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** One recorded step. Values must be primitives or shallow arrays of them. */
export type TraceEvent = Record<string, string | number | boolean | null>

export type Trace = (event: string, data?: TraceEvent) => void

export const DEFAULT_TRACE_PATH = '.opencode/orchestra-debug.jsonl'

/** A trace that discards everything, so callers never null-check. */
export const NO_TRACE: Trace = () => {
  // Deliberately empty: this is the switched-off trace. A no-op rather than
  // `undefined` so callers never guard the call itself.
}

/**
 * Appends one JSON object per line.
 *
 * Synchronous and deliberately unguarded: a trace must never be the reason a
 * delegation fails, so a write error is swallowed. The cost is that a full disk
 * loses the last few lines, which is the right way round for a diagnostic.
 */
export function createFileTrace(path: string): Trace {
  let ready = false
  return (event, data = {}) => {
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true })
        ready = true
      }
      appendFileSync(path, `${JSON.stringify({ t: Date.now(), event, ...data })}\n`, 'utf8')
    } catch {
      // A trace that throws would turn a working dispatch into a broken one.
    }
  }
}

/** How a value will be rendered in a trace, without rendering it. */
function shapeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}

/**
 * The shape of a session transcript: one entry per message.
 *
 * Reports `type` (what `extractReply` discriminates on), the key names present,
 * and each key's value type. When the real shape differs from what
 * `extractReply` expects, the disagreement shows here without the content ever
 * being read.
 */
export function describeShape(messages: readonly unknown[]): string {
  if (!Array.isArray(messages)) return `not-an-array(${shapeOf(messages)})`
  return messages
    .map((message, index) => {
      if (!message || typeof message !== 'object') return `${index}:${shapeOf(message)}`
      const record = message as Record<string, unknown>
      const type = typeof record.type === 'string' ? record.type : '(no type)'
      const keys = Object.keys(record)
        .map(key => `${key}:${shapeOf(record[key])}`)
        .sort()
        .join(',')
      return `${index} type=${type} {${keys}}`
    })
    .join(' | ')
}

/**
 * Why an attempt failed, in one word, for a trace line.
 *
 * `refused` is the interesting one: it separates "the provider said no" from
 * "the reply came back empty", which look identical to a caller and are
 * different bugs.
 */
export function classifyTraceError(error: unknown): string {
  if (error === undefined) return 'undefined'
  if (error instanceof Error) return `error:${error.name}`
  return `error:${shapeOf(error)}`
}
